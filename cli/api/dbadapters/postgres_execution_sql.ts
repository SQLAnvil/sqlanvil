import * as semver from "semver";

import { IExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { concatenateQueries, Task, Tasks } from "sa/cli/api/dbadapters/tasks";
import { ErrorWithCause } from "sa/common/errors/errors";
import { CompilationSql } from "sa/core/compilation_sql";
import { tableTypeEnumToString } from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

export class PostgresExecutionSql implements IExecutionSql {
  private readonly CompilationSql: CompilationSql;

  constructor(
    private readonly project: sqlanvil.IProjectConfig,
    private readonly sqlanvilCoreVersion: string,
    private readonly uniqueIdGenerator: () => string = () => Math.random().toString(36).substring(2)
  ) {
    this.CompilationSql = new CompilationSql(project, sqlanvilCoreVersion);
  }

  public baseTableType(enumType: sqlanvil.TableType) {
    switch (enumType) {
      case sqlanvil.TableType.TABLE:
      case sqlanvil.TableType.INCREMENTAL:
        return sqlanvil.TableMetadata.Type.TABLE;
      case sqlanvil.TableType.VIEW:
        return sqlanvil.TableMetadata.Type.VIEW;
      default:
        throw new Error(`Unexpected table type: ${tableTypeEnumToString(enumType)}`);
    }
  }

  public tableTypeAsSql(type: sqlanvil.TableMetadata.Type) {
    switch (type) {
      case sqlanvil.TableMetadata.Type.TABLE:
        return "table";
      case sqlanvil.TableMetadata.Type.VIEW:
        return "view";
      default:
        throw new Error(`Unexpected table type: ${type}`);
    }
  }

  public resolveTarget(target: sqlanvil.ITarget) {
    return this.CompilationSql.resolveTarget(target);
  }

  public dropIfExists(target: sqlanvil.ITarget, type: sqlanvil.TableMetadata.Type) {
    const kind = type === sqlanvil.TableMetadata.Type.VIEW ? "view" : "table";
    return `drop ${kind} if exists ${this.resolveTarget(target)} cascade`;
  }

  public shouldWriteIncrementally(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ) {
    return (
      (!runConfig.fullRefresh || table.protected) &&
      tableMetadata &&
      tableMetadata.type !== sqlanvil.TableMetadata.Type.VIEW
    );
  }

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

  public getIncrementalQuery(table: sqlanvil.ITable): string {
    return table.incrementalQuery || table.query;
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    const tasks = new Tasks();

    // Run Pre-operations
    this.preOps(table, runConfig, tableMetadata).forEach(statement => tasks.add(statement));

    const baseTableType = this.baseTableType(table.enumType);

    // If the object exists but is of a different database type (e.g. view instead of table), drop it cascade
    if (tableMetadata && tableMetadata.type !== baseTableType) {
      tasks.add(
        Task.statement(this.dropIfExists(table.target, this.oppositeTableType(baseTableType)))
      );
    }

    if (table.enumType === sqlanvil.TableType.INCREMENTAL) {
      if (!this.shouldWriteIncrementally(table, runConfig, tableMetadata)) {
        // Full Refresh / Table doesn't exist yet: Create table fresh
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(Task.statement(this.createTable(table)));
        if (table.uniqueKey && table.uniqueKey.length > 0) {
          const indexName = `pk_${table.target.schema}_${table.target.name}`;
          const columns = table.uniqueKey.map(k => `"${k}"`).join(", ");
          tasks.add(
            Task.statement(
              `create unique index if not exists "${indexName}" on ${this.resolveTarget(table.target)} (${columns})`
            )
          );
        }
        this.createIndexes(table).forEach(statement => tasks.add(Task.statement(statement)));
      } else {
        // Incremental Load: execute UPSERT or INSERT
        if (table.uniqueKey && table.uniqueKey.length > 0) {
          // UPSERT using standard Postgres INSERT ... ON CONFLICT DO UPDATE
          tasks.add(Task.statement(this.upsertInto(table, tableMetadata)));
        } else {
          // Standard positional column insert
          tasks.add(Task.statement(this.insertInto(table, tableMetadata)));
        }
      }
    } else if (table.enumType === sqlanvil.TableType.VIEW) {
      if (table.materialized) {
        // Postgres materialized view: drop + recreate (each run rebuilds with fresh
        // data). REFRESH-on-rerun is a future optimization.
        tasks.add(
          Task.statement(
            `drop materialized view if exists ${this.resolveTarget(table.target)} cascade`
          )
        );
        tasks.add(Task.statement(this.createMaterializedView(table)));
        this.createIndexes(table).forEach(statement => tasks.add(Task.statement(statement)));
      } else {
        // Views in Postgres are dropped and re-created to allow safe column modifications
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.VIEW)));
        tasks.add(Task.statement(this.createView(table)));
      }
    } else {
      const partition = table.postgres?.partition;
      if (partition && (partition.columns || []).length > 0) {
        // Partitioned table: CREATE TABLE AS can't PARTITION BY, so bridge via a
        // staging table to learn column types, then build the partitioned parent.
        this.createPartitionedTableTasks(table).forEach(statement =>
          tasks.add(Task.statement(statement))
        );
      } else {
        // Standard Table: Drop if exists and create table fresh
        tasks.add(Task.statement(this.dropIfExists(table.target, sqlanvil.TableMetadata.Type.TABLE)));
        tasks.add(Task.statement(this.createTable(table)));
      }
      this.createIndexes(table).forEach(statement => tasks.add(Task.statement(statement)));
    }

    // Run Post-operations
    this.postOps(table, runConfig, tableMetadata).forEach(statement => tasks.add(statement));

    return tasks;
  }

  public assertTasks(
    assertion: sqlanvil.IAssertion,
    projectConfig: sqlanvil.IProjectConfig,
  ): Tasks {
    const tasks = new Tasks();
    const target = assertion.target;
    // Create view to check syntax of assertion query
    tasks.add(Task.statement(this.dropIfExists(target, sqlanvil.TableMetadata.Type.VIEW)));
    tasks.add(Task.statement(`create view ${this.resolveTarget(target)} as ${assertion.query}`));

    // Add assertion validation task
    tasks.add(Task.assertion(`select sum(1) as row_count from ${this.resolveTarget(target)}`));
    return tasks;
  }

  private oppositeTableType(type: sqlanvil.TableMetadata.Type) {
    return type === sqlanvil.TableMetadata.Type.TABLE
      ? sqlanvil.TableMetadata.Type.VIEW
      : sqlanvil.TableMetadata.Type.TABLE;
  }

  private createTable(table: sqlanvil.ITable) {
    // Postgres dialect: CREATE [UNLOGGED] TABLE target [WITH (...)] [TABLESPACE ...] AS query
    const target = this.resolveTarget(table.target);
    const opts = table.postgres;
    const unlogged = opts?.unlogged ? "unlogged " : "";
    const withClause = opts?.fillfactor ? ` with (fillfactor=${opts.fillfactor})` : "";
    const tablespace = opts?.tablespace ? ` tablespace "${opts.tablespace}"` : "";
    return `create ${unlogged}table ${target}${withClause}${tablespace} as ${table.query}`;
  }

  // Postgres index DDL from the table's `postgres.indexes` config, returned as
  // separate statements to run after the table is created.
  private createIndexes(table: sqlanvil.ITable): string[] {
    const indexes = table.postgres?.indexes;
    if (!indexes || indexes.length === 0) {
      return [];
    }
    const target = this.resolveTarget(table.target);
    return indexes.map(index => {
      const unique = index.unique ? "unique " : "";
      const method = this.indexMethodAsSql(index.method);
      const opclass = index.opclass ? ` ${index.opclass}` : "";
      const columns = (index.columns || []).map(c => `"${c}"${opclass}`).join(", ");
      const include =
        index.include && index.include.length > 0
          ? ` include (${index.include.map(c => `"${c}"`).join(", ")})`
          : "";
      const where = index.where ? ` where (${index.where})` : "";
      return `create ${unique}index "${index.name}" on ${target} using ${method} (${columns})${include}${where}`;
    });
  }

  private indexMethodAsSql(method?: sqlanvil.PostgresOptions.Index.Method): string {
    switch (method) {
      case sqlanvil.PostgresOptions.Index.Method.HASH:
        return "hash";
      case sqlanvil.PostgresOptions.Index.Method.GIN:
        return "gin";
      case sqlanvil.PostgresOptions.Index.Method.GIST:
        return "gist";
      case sqlanvil.PostgresOptions.Index.Method.BRIN:
        return "brin";
      case sqlanvil.PostgresOptions.Index.Method.BTREE:
      default:
        return "btree";
    }
  }

  // Builds a native-partitioned table. Postgres forbids CREATE TABLE AS with
  // PARTITION BY and needs explicit columns, so we stage the query (WITH NO DATA)
  // to learn column types, LIKE it into the partitioned parent, create the child
  // partitions, then INSERT the real query.
  private createPartitionedTableTasks(table: sqlanvil.ITable): string[] {
    const partition = table.postgres.partition;
    const target = this.resolveTarget(table.target);
    const stage = this.resolveTarget({ ...table.target, name: `${table.target.name}__sa_stage` });
    const kind = this.partitionKindAsSql(partition.kind);
    const columns = (partition.columns || []).map(c => `"${c}"`).join(", ");

    const statements = [
      `drop table if exists ${stage} cascade`,
      `create unlogged table ${stage} as ${table.query} with no data`,
      `drop table if exists ${target} cascade`,
      `create table ${target} (like ${stage} including defaults) partition by ${kind} (${columns})`
    ];
    for (const bound of partition.partitions || []) {
      const child = this.resolveTarget({
        ...table.target,
        name: `${table.target.name}__${bound.name}`
      });
      statements.push(`create table ${child} partition of ${target} for values ${bound.values}`);
    }
    if (partition.includeDefault) {
      const def = this.resolveTarget({ ...table.target, name: `${table.target.name}__default` });
      statements.push(`create table ${def} partition of ${target} default`);
    }
    statements.push(`insert into ${target} select * from (${table.query}) as q`);
    statements.push(`drop table if exists ${stage} cascade`);
    return statements;
  }

  private partitionKindAsSql(kind?: sqlanvil.PostgresOptions.Partition.Kind): string {
    switch (kind) {
      case sqlanvil.PostgresOptions.Partition.Kind.LIST:
        return "list";
      case sqlanvil.PostgresOptions.Partition.Kind.HASH:
        return "hash";
      case sqlanvil.PostgresOptions.Partition.Kind.RANGE:
      default:
        return "range";
    }
  }

  private createView(table: sqlanvil.ITable) {
    // Postgres dialect: CREATE VIEW target AS query
    const target = this.resolveTarget(table.target);
    return `create view ${target} as ${table.query}`;
  }

  private createMaterializedView(table: sqlanvil.ITable) {
    // Postgres dialect: CREATE MATERIALIZED VIEW target AS query (WITH DATA by default).
    const target = this.resolveTarget(table.target);
    return `create materialized view ${target} as ${table.query}`;
  }

  private insertInto(table: sqlanvil.ITable, tableMetadata?: sqlanvil.ITableMetadata) {
    // Postgres dialect: INSERT INTO target (col1, col2) SELECT col1, col2 FROM (query) AS insertions
    const target = this.resolveTarget(table.target);
    const columns = tableMetadata?.fields.map(f => `"${f.name}"`) || [];
    const query = this.getIncrementalQuery(table);
    if (columns.length === 0) {
      return `insert into ${target} select * from (${query}) as insertions`;
    }
    return `insert into ${target} (${columns.join(", ")}) select ${columns.join(", ")} from (${query}) as insertions`;
  }

  private upsertInto(table: sqlanvil.ITable, tableMetadata?: sqlanvil.ITableMetadata) {
    // Postgres dialect: INSERT INTO target (col1, col2) SELECT col1, col2 FROM (query) AS insertions
    // ON CONFLICT (unique_keys) DO UPDATE SET col1 = EXCLUDED.col1, ...
    const target = this.resolveTarget(table.target);
    const columns = tableMetadata?.fields.map(f => f.name) || [];
    const query = this.getIncrementalQuery(table);
    const uniqueKeys = table.uniqueKey.map(k => `"${k}"`).join(", ");

    if (columns.length === 0) {
      // If columns are unknown, we default to standard inserts
      return `insert into ${target} select * from (${query}) as insertions`;
    }

    const doubleQuotedCols = columns.map(c => `"${c}"`);
    const updateClauses = columns
      .filter(c => !table.uniqueKey.includes(c))
      .map(c => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");

    const onConflict = updateClauses.length > 0
      ? `on conflict (${uniqueKeys}) do update set ${updateClauses}`
      : `on conflict (${uniqueKeys}) do nothing`;

    return `insert into ${target} (${doubleQuotedCols.join(", ")}) select ${doubleQuotedCols.join(", ")} from (${query}) as insertions ${onConflict}`;
  }
}
