import * as semver from "semver";

import { IExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { Task, Tasks } from "sa/cli/api/dbadapters/tasks";
import { CompilationSql } from "sa/core/compilation_sql";
import { sqlanvil } from "sa/protos/ts";

// MySQL/MariaDB DDL/DML generator. Emits portable MySQL-dialect SQL — the same
// statements run against both engines (engine-specific features ride through
// `operations`). Mirrors PostgresExecutionSql's structure. Supports table options
// + secondary indexes (the `mysql:{}` block) and materialized views (emulated as a
// refreshed table snapshot); COMMENT metadata is applied by the adapter's
// setMetadata. Still deferred: partitioning and FULLTEXT/SPATIAL/prefix indexes.
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

  public createExportTasks(exp: sqlanvil.IExport): sqlanvil.IExecutionTask[] {
    throw new Error("type: \"export\" is not supported on MySQL/MariaDB yet.");
  }

  // --- `sqlanvil validate`: empty, isolated shadow-database stubs. ---

  public validationStubSql(table: sqlanvil.ITable): string {
    const target = this.resolveTarget(table.target);
    if (table.enumType === sqlanvil.TableType.VIEW) {
      return `create or replace view ${target} as ${table.query}`;
    }
    // MySQL has no WITH NO DATA; wrapping + LIMIT 0 yields an empty, correctly-typed table
    // (the wrap also keeps UNION/ORDER BY queries valid as a derived table).
    return `create table ${target} as select * from (${table.query}) as _sa_stub limit 0`;
  }

  public createSchemaSql(schema: string): string {
    return `create database if not exists \`${schema}\``;
  }

  public dropSchemaCascadeSql(schema: string): string {
    return `drop database if exists \`${schema}\``;
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    const tasks = new Tasks();
    const target = this.resolveTarget(table.target);

    // Pre-operations (an incremental append swaps in incrementalPreOps, semver-gated
    // > 1.4.8, so one-time DDL stays on the create path). Mirrors Postgres/BigQuery.
    this.preOps(table, runConfig, tableMetadata).forEach(task => tasks.add(task));

    if (table.enumType === sqlanvil.TableType.VIEW) {
      if (table.materialized) {
        // MySQL/MariaDB have no native materialized views — emulate as a real
        // table snapshot, refreshed by drop + CTAS each run (mirrors the Postgres
        // matview default). Drop both the view and table forms so the path is
        // idempotent whether the prior object was a view or a table.
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.VIEW)));
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(
          Task.statement(`create table ${target}${this.tableOptions(table)}${this.partitionClause(table)} as ${table.query}`)
        );
        this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
      } else {
        // CREATE OR REPLACE VIEW is atomic in MySQL/MariaDB — no drop needed.
        tasks.add(Task.statement(`create or replace view ${target} as ${table.query}`));
      }
    } else if (table.enumType === sqlanvil.TableType.INCREMENTAL) {
      const fresh = !this.shouldWriteIncrementally(table, runConfig, tableMetadata);
      if (fresh) {
        // Full refresh or first build: drop + CTAS, then add the unique index that
        // ON DUPLICATE KEY UPDATE relies on for subsequent incremental appends.
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(Task.statement(`create table ${target}${this.tableOptions(table)}${this.partitionClause(table)} as ${table.query}`));
        if (table.uniqueKey && table.uniqueKey.length > 0) {
          const idx = `uq_${table.target.schema}_${table.target.name}`.slice(0, 63);
          const cols = table.uniqueKey.map(k => `\`${k}\``).join(", ");
          tasks.add(Task.statement(`alter table ${target} add unique index \`${idx}\` (${cols})`));
        }
        this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
      } else {
        tasks.add(Task.statement(this.upsertInto(table, tableMetadata)));
      }
    } else {
      // Plain table: drop + CTAS (with table options) + secondary indexes.
      tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
      tasks.add(Task.statement(`create table ${target}${this.tableOptions(table)}${this.partitionClause(table)} as ${table.query}`));
      this.createIndexes(table).forEach(stmt => tasks.add(Task.statement(stmt)));
    }

    // Post-operations (incremental append swaps in incrementalPostOps, as above).
    this.postOps(table, runConfig, tableMetadata).forEach(task => tasks.add(task));

    return tasks;
  }

  // pre_operations / post_operations attached to a table/view/incremental model.
  // On an incremental append (table already exists, not a full refresh) the
  // compiler emits the incremental* variants instead, so one-time create-path DDL
  // does not re-run. Semver-gated > 1.4.8 to match Postgres/BigQuery.
  public preOps(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Task[] {
    let preOps = table.preOps;
    if (
      semver.gt(this.sqlanvilCoreVersion, "1.4.8") &&
      table.enumType === sqlanvil.TableType.INCREMENTAL &&
      this.shouldWriteIncrementally(table, runConfig, tableMetadata)
    ) {
      preOps = table.incrementalPreOps;
    }
    return (preOps || []).map(pre => Task.statement(pre));
  }

  public postOps(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Task[] {
    let postOps = table.postOps;
    if (
      semver.gt(this.sqlanvilCoreVersion, "1.4.8") &&
      table.enumType === sqlanvil.TableType.INCREMENTAL &&
      this.shouldWriteIncrementally(table, runConfig, tableMetadata)
    ) {
      postOps = table.incrementalPostOps;
    }
    return (postOps || []).map(post => Task.statement(post));
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

  private partitionKindAsSql(kind?: sqlanvil.MysqlOptions.Partition.Kind): string {
    switch (kind) {
      case sqlanvil.MysqlOptions.Partition.Kind.LIST:
        return "list";
      case sqlanvil.MysqlOptions.Partition.Kind.HASH:
        return "hash";
      case sqlanvil.MysqlOptions.Partition.Kind.KEY:
        return "key";
      case sqlanvil.MysqlOptions.Partition.Kind.RANGE:
      default:
        return "range";
    }
  }

  // The `PARTITION BY …` suffix for a CTAS create path (MySQL grammar puts partition
  // options after table options, before AS query). HASH/KEY use `PARTITIONS <n>`;
  // RANGE/LIST emit explicit `PARTITION <name> <values>` child definitions verbatim.
  private partitionClause(table: sqlanvil.ITable): string {
    const partition = table.mysql && table.mysql.partition;
    if (!partition) {
      return "";
    }
    const kind = this.partitionKindAsSql(partition.kind);
    const head = ` partition by ${kind} (${partition.expression})`;
    if (kind === "hash" || kind === "key") {
      return partition.count ? `${head} partitions ${partition.count}` : head;
    }
    const defs = (partition.partitions || [])
      .map(bound => `partition ${bound.name} ${bound.values}`)
      .join(", ");
    return `${head} (${defs})`;
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
