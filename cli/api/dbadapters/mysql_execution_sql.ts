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
        // MySQL/MariaDB have no native materialized views — emulate as a real
        // table snapshot, refreshed by drop + CTAS each run (mirrors the Postgres
        // matview default). Drop both the view and table forms so the path is
        // idempotent whether the prior object was a view or a table.
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.VIEW)));
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(
          Task.statement(`create table ${target}${this.tableOptions(table)} as ${table.query}`)
        );
        this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
        return tasks;
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
        tasks.add(Task.statement(`create table ${target}${this.tableOptions(table)} as ${table.query}`));
        if (table.uniqueKey && table.uniqueKey.length > 0) {
          const idx = `uq_${table.target.schema}_${table.target.name}`.slice(0, 63);
          const cols = table.uniqueKey.map(k => `\`${k}\``).join(", ");
          tasks.add(Task.statement(`alter table ${target} add unique index \`${idx}\` (${cols})`));
        }
        this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
      } else {
        tasks.add(Task.statement(this.upsertInto(table, tableMetadata)));
      }
      return tasks;
    }

    // Plain table: drop + CTAS (with table options) + secondary indexes.
    tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
    tasks.add(Task.statement(`create table ${target}${this.tableOptions(table)} as ${table.query}`));
    this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
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
      // No known columns means no tableMetadata — but this path only runs when
      // shouldWriteIncrementally() already required tableMetadata, so columns are
      // populated in practice. The bare insert is a defensive fallback; with a
      // uniqueKey present it could hit the unique index, so it's intentionally
      // never the upsert path.
      return `insert into ${target} select * from (${query}) as insertions`;
    }
    const backticked = columns.map(c => `\`${c}\``);
    // Only an upsert when a uniqueKey exists — the unique index created on first
    // build is what ON DUPLICATE KEY UPDATE matches against. Without it this is a
    // plain append (the inert clause would never fire anyway).
    const uniqueKey = table.uniqueKey || [];
    const updates =
      uniqueKey.length > 0
        ? columns
            .filter(c => !uniqueKey.includes(c))
            .map(c => `\`${c}\` = values(\`${c}\`)`)
            .join(", ")
        : "";
    const tail = updates.length > 0 ? ` on duplicate key update ${updates}` : "";
    return `insert into ${target} (${backticked.join(", ")}) select ${backticked.join(
      ", "
    )} from (${query}) as insertions${tail}`;
  }

  // Table-options suffix for a CTAS create path, e.g. " engine=InnoDB default
  // charset=utf8mb4 collate=utf8mb4_unicode_ci". Emitted verbatim (author-trusted,
  // same trust model as the Postgres adapter's tablespace/fillfactor).
  private tableOptions(table: sqlanvil.ITable): string {
    const opts = table.mysql;
    if (!opts) {
      return "";
    }
    let suffix = "";
    if (opts.engine) {
      suffix += ` engine=${opts.engine}`;
    }
    if (opts.charset) {
      suffix += ` default charset=${opts.charset}`;
    }
    if (opts.collation) {
      suffix += ` collate=${opts.collation}`;
    }
    return suffix;
  }

  // One `ALTER TABLE ... ADD [UNIQUE] INDEX` per declared index (same form as the
  // uniqueKey index in publishTasks). Returned as separate statements to run after
  // the table is created.
  private createIndexes(table: sqlanvil.ITable): string[] {
    const indexes = table.mysql?.indexes;
    if (!indexes || indexes.length === 0) {
      return [];
    }
    const target = this.resolveTarget(table.target);
    return indexes.map(index => {
      const unique = index.unique ? "unique " : "";
      const cols = (index.columns || []).map(c => `\`${c}\``).join(", ");
      const name =
        index.name || this.defaultIndexName(table.target.name, index.columns, !!index.unique);
      return `alter table ${target} add ${unique}index \`${name}\` (${cols})`;
    });
  }

  // Derive an index name from table + columns (mirrors the Postgres helper and the
  // uq_ uniqueKey convention): <table>_<cols>_idx (or _key if unique), 63-char cap.
  private defaultIndexName(tableName: string, columns: string[], unique: boolean): string {
    const parts = [tableName, ...(columns || [])].filter(Boolean);
    const suffix = unique ? "_key" : "_idx";
    return `${parts.join("_")}${suffix}`.slice(0, 63);
  }
}
