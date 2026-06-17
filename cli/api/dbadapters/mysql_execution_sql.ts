import { IExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { Task, Tasks } from "sa/cli/api/dbadapters/tasks";
import { CompilationSql } from "sa/core/compilation_sql";
import { sqlanvil } from "sa/protos/ts";

// MySQL/MariaDB DDL/DML generator. Emits portable MySQL-dialect SQL — the same
// statements run against both engines (engine-specific features ride through
// `operations`). Mirrors PostgresExecutionSql's structure; deliberately omits
// the Postgres-only surface (storage options, partitioning, materialized views,
// COMMENT metadata) — see the adapter design doc for what's deferred.
export class MysqlExecutionSql implements IExecutionSql {
  private readonly CompilationSql: CompilationSql;

  constructor(
    private readonly project: sqlanvil.IProjectConfig,
    private readonly sqlanvilCoreVersion: string,
    private readonly uniqueIdGenerator: () => string = () => Math.random().toString(36).substring(2)
  ) {
    this.CompilationSql = new CompilationSql(project, sqlanvilCoreVersion);
  }

  public resolveTarget(target: sqlanvil.ITarget): string {
    return this.CompilationSql.resolveTarget(target);
  }

  public dropIfExists(target: sqlanvil.ITarget, type: sqlanvil.TableMetadata.Type): string {
    if (type === sqlanvil.TableMetadata.Type.VIEW) {
      return `drop view if exists ${this.resolveTarget(target)}`;
    }
    return `drop table if exists ${this.resolveTarget(target)}`;
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    const tasks = new Tasks();
    const target = this.resolveTarget(table.target);

    if (table.enumType === sqlanvil.TableType.VIEW) {
      if (table.materialized) {
        throw new Error(
          `Materialized views are not supported on mysql (action ${target}). ` +
            `Use a table, or emulate refresh via operations.`
        );
      }
      // CREATE OR REPLACE VIEW is atomic in MySQL/MariaDB — no drop needed.
      tasks.add(Task.statement(`create or replace view ${target} as ${table.query}`));
      return tasks;
    }

    if (table.enumType === sqlanvil.TableType.INCREMENTAL) {
      const fresh = !this.shouldWriteIncrementally(table, runConfig, tableMetadata);
      if (fresh) {
        // Full refresh or first build: drop + CTAS, then add the unique index that
        // ON DUPLICATE KEY UPDATE relies on for subsequent incremental appends.
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(Task.statement(`create table ${target} as ${table.query}`));
        if (table.uniqueKey && table.uniqueKey.length > 0) {
          const idx = `uq_${table.target.schema}_${table.target.name}`.slice(0, 63);
          const cols = table.uniqueKey.map(k => `\`${k}\``).join(", ");
          tasks.add(Task.statement(`alter table ${target} add unique index \`${idx}\` (${cols})`));
        }
      } else {
        tasks.add(Task.statement(this.upsertInto(table, tableMetadata)));
      }
      return tasks;
    }

    // Plain table: drop + CTAS.
    tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
    tasks.add(Task.statement(`create table ${target} as ${table.query}`));
    return tasks;
  }

  public assertTasks(
    assertion: sqlanvil.IAssertion,
    projectConfig: sqlanvil.IProjectConfig
  ): Tasks {
    // The assertion query is warehouse-agnostic SQL produced by the compiler.
    // Mirror the Postgres path: materialize it as a view (catches syntax errors),
    // then count rows — any returned row is a failing record.
    const tasks = new Tasks();
    const target = this.resolveTarget(assertion.target);
    tasks.add(Task.statement(this.dropIfExists(assertion.target, sqlanvil.TableMetadata.Type.VIEW)));
    tasks.add(Task.statement(`create or replace view ${target} as ${assertion.query}`));
    tasks.add(Task.assertion(`select sum(1) as row_count from ${target}`));
    return tasks;
  }

  private shouldWriteIncrementally(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): boolean {
    return (
      !runConfig.fullRefresh &&
      !!tableMetadata &&
      tableMetadata.type === sqlanvil.TableMetadata.Type.TABLE
    );
  }

  private getIncrementalQuery(table: sqlanvil.ITable): string {
    return table.incrementalQuery || table.query;
  }

  private upsertInto(table: sqlanvil.ITable, tableMetadata?: sqlanvil.ITableMetadata): string {
    // MySQL dialect: INSERT INTO target (cols) SELECT cols FROM (query) AS insertions
    // ON DUPLICATE KEY UPDATE col = values(col), ... — relies on the unique index
    // created on first build.
    const target = this.resolveTarget(table.target);
    const columns = (tableMetadata?.fields || []).map(f => f.name);
    const query = this.getIncrementalQuery(table);
    if (columns.length === 0) {
      return `insert into ${target} select * from (${query}) as insertions`;
    }
    const backticked = columns.map(c => `\`${c}\``);
    const updates = columns
      .filter(c => !(table.uniqueKey || []).includes(c))
      .map(c => `\`${c}\` = values(\`${c}\`)`)
      .join(", ");
    const tail = updates.length > 0 ? ` on duplicate key update ${updates}` : "";
    return `insert into ${target} (${backticked.join(", ")}) select ${backticked.join(
      ", "
    )} from (${query}) as insertions${tail}`;
  }
}
