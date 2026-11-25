import * as semver from "semver";

import { IExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { resolveExportUri } from "sa/cli/api/dbadapters/export_uri";
import { concatenateQueries, Task, Tasks, terminateStatements } from "sa/cli/api/dbadapters/tasks";
import { ErrorWithCause } from "sa/common/errors/errors";
import { CompilationSql } from "sa/core/compilation_sql";
import { tableTypeEnumToString } from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

export class BigQueryExecutionSql implements IExecutionSql {
  private readonly CompilationSql: CompilationSql;

  constructor(
    private readonly project: sqlanvil.IProjectConfig,
    private readonly sqlanvilCoreVersion: string,
    private readonly uniqueIdGenerator: () => string = () =>
      Math.random().toString(36).substring(2),
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

  /**
   * With `columns`, a static INSERT. Without, the column list is only known inside the
   * onSchemaChange procedure (after its ALTERs), so the statement is built there and run with
   * EXECUTE IMMEDIATE (upstream #2320).
   */
  private insertInto(target: sqlanvil.ITarget, columns: string[] | undefined, source: string) {
    const cols = this.colsList(columns);
    const resolvedTarget = this.resolveDmlTarget(target, columns);
    const dml = `	
insert into ${resolvedTarget}
(${cols})
select ${cols}
from ${source}`;
    return columns ? dml : `EXECUTE IMMEDIATE ("""${dml}""");`;
  }

  public oppositeTableType(type: sqlanvil.TableMetadata.Type) {
    switch (type) {
      case sqlanvil.TableMetadata.Type.TABLE:
        return sqlanvil.TableMetadata.Type.VIEW;
      case sqlanvil.TableMetadata.Type.VIEW:
        return sqlanvil.TableMetadata.Type.TABLE;
      default:
        throw new Error(`Unexpected table type: ${type}`);
    }
  }

  public where(query: string, where: string) {
    return where
      ? `
  select * from (${query}) as subquery
    where ${where}`
      : query;
  }

  public shouldWriteIncrementally(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata,
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
    tableMetadata?: sqlanvil.ITableMetadata,
  ): Task[] {
    let preOps = table.preOps;
    if (
      semver.gt(this.sqlanvilCoreVersion, "1.4.8") &&
      table.enumType === sqlanvil.TableType.INCREMENTAL &&
      this.shouldWriteIncrementally(table, runConfig, tableMetadata)
    ) {
      preOps = table.incrementalPreOps;
    }
    return (preOps || []).map((pre) => Task.statement(pre));
  }

  public postOps(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata,
  ): Task[] {
    let postOps = table.postOps;
    if (
      semver.gt(this.sqlanvilCoreVersion, "1.4.8") &&
      table.enumType === sqlanvil.TableType.INCREMENTAL &&
      this.shouldWriteIncrementally(table, runConfig, tableMetadata)
    ) {
      postOps = table.incrementalPostOps;
    }
    return (postOps || []).map((post) => Task.statement(post));
  }

  public resolveTarget(target: sqlanvil.ITarget) {
    return this.CompilationSql.resolveTarget(target);
  }

  public getIncrementalQuery(table: sqlanvil.ITable): string {
    return this.where(table.incrementalQuery || table.query, table.where);
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata,
  ): Tasks {
    const preOpTasks = this.preOps(table, runConfig, tableMetadata);
    const postOpTasks = this.postOps(table, runConfig, tableMetadata);
    const tasks =
      table.enumType === sqlanvil.TableType.INCREMENTAL
        ? this.buildIncrementalTasks(table, runConfig, preOpTasks, postOpTasks, tableMetadata)
        : this.buildNonIncrementalTasks(table, preOpTasks, postOpTasks, tableMetadata);
    return tasks.concatenate();
  }

  private buildNonIncrementalTasks(
    table: sqlanvil.ITable,
    preOpTasks: Task[],
    postOpTasks: Task[],
    tableMetadata?: sqlanvil.ITableMetadata,
  ): Tasks {
    const tasks = new Tasks();

    preOpTasks.forEach((statement) => tasks.add(statement));

    const baseTableType = this.baseTableType(table.enumType);
    if (tableMetadata && tableMetadata.type !== baseTableType) {
      tasks.add(
        Task.statement(this.dropIfExists(table.target, this.oppositeTableType(baseTableType))),
      );
    }
    tasks.add(Task.statement(this.createOrReplace(table)));
    postOpTasks.forEach((statement) => tasks.add(statement));

    return tasks;
  }

  /**
   * An incremental append with onSchemaChange FAIL / EXTEND / SYNCHRONIZE runs entirely inside a
   * stored procedure (upstream #2320): pre-operations, the schema comparison and ALTERs, the DML
   * (built from the column list as it is after the ALTERs) and post-operations. Before, the DML ran
   * after the procedure with the column list read before the run, so added columns stayed NULL
   * for the rows of that run and a SYNCHRONIZE that dropped a column failed it.
   */
  private buildIncrementalTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    preOpTasks: Task[],
    postOpTasks: Task[],
    tableMetadata?: sqlanvil.ITableMetadata,
  ): Tasks {
    const tasks = new Tasks();

    const writesIncrementally = this.shouldWriteIncrementally(table, runConfig, tableMetadata);
    const usesSchemaChangeProcedure =
      writesIncrementally &&
      (table.onSchemaChange ?? sqlanvil.OnSchemaChange.IGNORE) !== sqlanvil.OnSchemaChange.IGNORE;

    if (!usesSchemaChangeProcedure) {
      preOpTasks.forEach((statement) => tasks.add(statement));
    }

    const baseTableType = this.baseTableType(table.enumType);
    if (tableMetadata && tableMetadata.type !== baseTableType) {
      tasks.add(
        Task.statement(this.dropIfExists(table.target, this.oppositeTableType(baseTableType))),
      );
    }

    if (!writesIncrementally) {
      tasks.add(Task.statement(this.createOrReplace(table)));
    } else {
      const onSchemaChange = table.onSchemaChange ?? sqlanvil.OnSchemaChange.IGNORE;
      switch (onSchemaChange) {
        case sqlanvil.OnSchemaChange.FAIL:
        case sqlanvil.OnSchemaChange.EXTEND:
        case sqlanvil.OnSchemaChange.SYNCHRONIZE:
          this.buildIncrementalSchemaChangeTasks(tasks, table, preOpTasks, postOpTasks);
          break;
        case sqlanvil.OnSchemaChange.IGNORE:
          tasks.add(
            Task.statement(
              this.getIncrementalDmlStatement(
                table,
                tableMetadata?.fields.map((f) => f.name) || [],
              ),
            ),
          );
          break;
        default:
          throw new Error(
            `Unexpected onSchemaChange policy: ${sqlanvil.OnSchemaChange[onSchemaChange]?.toLowerCase()}`,
          );
      }
    }

    if (!usesSchemaChangeProcedure) {
      postOpTasks.forEach((statement) => tasks.add(statement));
    }

    return tasks;
  }

  public assertTasks(
    assertion: sqlanvil.IAssertion,
    projectConfig: sqlanvil.IProjectConfig,
  ): Tasks {
    const tasks = new Tasks();
    const target = assertion.target;
    // Create the view to check syntax of assertion
    tasks.add(Task.statement(this.createOrReplaceView(target, assertion.query)));

    // Add assertion check
    tasks.add(Task.assertion(`select sum(1) as row_count from ${this.resolveTarget(target)}`));
    return tasks;
  }

  public dropIfExists(target: sqlanvil.ITarget, type: sqlanvil.TableMetadata.Type) {
    return `drop ${this.tableTypeAsSql(type)} if exists ${this.resolveTarget(target)}`;
  }

  public createExportTasks(exp: sqlanvil.IExport): sqlanvil.IExecutionTask[] {
    // BigQuery exports in-engine via EXPORT DATA. The URI must contain a `*` wildcard.
    const uri = resolveExportUri(exp, exp.target?.name || exp.filename, { wildcard: true });
    const format = (exp.format || "").toUpperCase();
    const statement =
      `EXPORT DATA OPTIONS(\n` +
      `  uri='${uri}',\n` +
      `  format='${format}',\n` +
      `  overwrite=${exp.overwrite ? "true" : "false"}\n` +
      `) AS\n${exp.query}`;
    return [sqlanvil.ExecutionTask.create({ type: "statement", statement })];
  }

  public createImportTasks(imp: sqlanvil.IImport): sqlanvil.IExecutionTask[] {
    // BigQuery imports in-engine via LOAD DATA from gs:// files (overwrite = replace, into = append).
    const target = this.resolveTarget(imp.target);
    const format = (imp.format || "").toUpperCase();
    const verb = imp.overwrite ? "OVERWRITE" : "INTO";
    const statement =
      `LOAD DATA ${verb} ${target}\n` +
      `FROM FILES (\n` +
      `  format = '${format}',\n` +
      `  uris = ['${imp.location}']\n` +
      `)`;
    return [sqlanvil.ExecutionTask.create({ type: "statement", statement })];
  }

  // --- `sqlanvil validate`: empty, isolated shadow-dataset stubs (dry-run powers evaluate()). ---

  public validationStubSql(table: sqlanvil.ITable): string {
    const target = this.resolveTarget(table.target);
    if (table.enumType === sqlanvil.TableType.VIEW) {
      return `create view ${target} as ${table.query}`;
    }
    // BigQuery has no WITH NO DATA; wrap + LIMIT 0 yields an empty, correctly-typed table.
    return `create table ${target} as select * from (${table.query}) limit 0`;
  }

  public createSchemaSql(schema: string): string {
    return `create schema if not exists ${this.qualifiedSchema(schema)}`;
  }

  public dropSchemaCascadeSql(schema: string): string {
    return `drop schema if exists ${this.qualifiedSchema(schema)} cascade`;
  }

  // A BigQuery dataset, qualified by the default project when one is configured (matches how
  // resolveTarget qualifies a table: `project.dataset.name`).
  private qualifiedSchema(schema: string): string {
    return this.project.defaultDatabase
      ? `\`${this.project.defaultDatabase}.${schema}\``
      : `\`${schema}\``;
  }

  private isMergeStrategy(table: sqlanvil.ITable): boolean {
    return (
      (table.incrementalStrategy === undefined ||
        table.incrementalStrategy === null ||
        table.incrementalStrategy === sqlanvil.IncrementalStrategy.MERGE ||
        table.incrementalStrategy ===
          sqlanvil.IncrementalStrategy.INCREMENTAL_STRATEGY_UNSPECIFIED) &&
      Boolean(table.uniqueKey && table.uniqueKey.length > 0)
    );
  }

  private buildIncrementalSchemaChangeTasks(
    tasks: Tasks,
    table: sqlanvil.ITable,
    preOpTasks: Task[] = [],
    postOpTasks: Task[] = [],
  ) {
    const uniqueId = this.uniqueIdGenerator();

    const emptyTempTableTarget = {
      ...table.target,
      name: `${table.target.name}_sa_temp_${uniqueId}_empty`,
    };

    const procedureName = this.createProcedureName(table.target, uniqueId);
    const procedureBody = this.incrementalSchemaChangeBody(
      table,
      this.resolveTarget(table.target),
      emptyTempTableTarget,
      preOpTasks,
      postOpTasks,
    );

    const createProcedureSql = `CREATE OR REPLACE PROCEDURE ${procedureName}()
OPTIONS(strict_mode=false)
BEGIN
${procedureBody}
END;`;

    const callProcedureSql = this.safeCallAndDropProcedure(
      procedureName,
      this.resolveTarget(emptyTempTableTarget),
    );
    tasks.add(Task.statement(createProcedureSql));
    tasks.add(Task.statement(callProcedureSql));
  }

  private createProcedureName(target: sqlanvil.ITarget, uniqueId: string): string {
    return this.resolveTarget({
      ...target,
      name: `sa_osc_${uniqueId}`,
    });
  }

  private safeCallAndDropProcedure(procedureName: string, emptyTempTableName: string): string {
    return `
BEGIN
  CALL ${procedureName}();
EXCEPTION WHEN ERROR THEN
  DROP TABLE IF EXISTS ${emptyTempTableName};
  DROP PROCEDURE IF EXISTS ${procedureName};
  RAISE;
END;
DROP PROCEDURE IF EXISTS ${procedureName};`;
  }

  private createEmptyTempTableSql(emptyTempTableName: string, query: string): string {
    return `
-- Create empty table to extract schema of new query.
CREATE OR REPLACE TABLE ${emptyTempTableName} AS (
  SELECT * FROM (${query}
) AS insertions LIMIT 0
);`;
  }

  // BigQuery only allows DECLARE at the start of a block, so every variable the procedure uses is
  // declared here, ahead of the temp-table CREATE (upstream dataform-co/dataform#2307).
  // Every variable is prefixed sqlanvil_, so it can't collide with one a pre- or post-operation
  // declares in the same procedure (upstream #2320).
  private declareSchemaChangeVariablesSql(table: sqlanvil.ITable): string {
    const onSchemaChange = table.onSchemaChange || sqlanvil.OnSchemaChange.IGNORE;

    let sql = `
-- Declare variables for schema comparison and strategy execution.
DECLARE sqlanvil_columns ARRAY<STRING>;
DECLARE sqlanvil_columns_list STRING;`;

    if (this.isMergeStrategy(table)) {
      sql += `\nDECLARE sqlanvil_columns_merge STRING;`;
    }

    sql += `
DECLARE sqlanvil_temp_table_columns ARRAY<STRUCT<column_name STRING, data_type STRING>>;
DECLARE sqlanvil_columns_added ARRAY<STRUCT<column_name STRING, data_type STRING>>;
DECLARE sqlanvil_columns_removed ARRAY<STRING>;`;

    if (onSchemaChange === sqlanvil.OnSchemaChange.SYNCHRONIZE) {
      sql += `\nDECLARE sqlanvil_invalid_removed_columns ARRAY<STRING>;`;
    }
    return sql;
  }

  private compareSchemasSql(
    target: sqlanvil.ITarget,
    emptyTempTableTarget: sqlanvil.ITarget,
  ): string {
    return `
-- Compare schemas
SET sqlanvil_columns = (
  SELECT IFNULL(ARRAY_AGG(DISTINCT column_name), [])
  FROM \`${target.database}.${target.schema}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE table_name = '${target.name}'
);

SET sqlanvil_temp_table_columns = (
  SELECT IFNULL(ARRAY_AGG(STRUCT(column_name, data_type)), [])
  FROM \`${emptyTempTableTarget.database}.${emptyTempTableTarget.schema}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE table_name = '${emptyTempTableTarget.name}'
);

SET sqlanvil_columns_added = (
  SELECT IFNULL(ARRAY_AGG(column_info), [])
  FROM UNNEST(sqlanvil_temp_table_columns) AS column_info
  WHERE column_info.column_name NOT IN UNNEST(sqlanvil_columns)
);
SET sqlanvil_columns_removed = (
  SELECT IFNULL(ARRAY_AGG(column_name), [])
  FROM UNNEST(sqlanvil_columns) AS column_name
  WHERE column_name NOT IN (SELECT col.column_name FROM UNNEST(sqlanvil_temp_table_columns) AS col)
);`;
  }

  private applySchemaChangeStrategySql(
    table: sqlanvil.ITable,
    qualifiedTargetTableName: string,
  ): string {
    const onSchemaChange = table.onSchemaChange || sqlanvil.OnSchemaChange.IGNORE;
    let sql = `
-- Apply schema change strategy (${sqlanvil.OnSchemaChange[onSchemaChange]}).`;

    switch (onSchemaChange) {
      case sqlanvil.OnSchemaChange.FAIL:
        sql += `
IF ARRAY_LENGTH(sqlanvil_columns_added) > 0 OR ARRAY_LENGTH(sqlanvil_columns_removed) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Schema mismatch defined by on_schema_change = 'FAIL'. Added columns: %T, removed columns: %T",
    sqlanvil_columns_added,
    sqlanvil_columns_removed
  );
END IF;
`;
        break;
      case sqlanvil.OnSchemaChange.EXTEND:
        sql += `
IF ARRAY_LENGTH(sqlanvil_columns_removed) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Column removals are not allowed when on_schema_change = 'EXTEND'. Removed columns: %T",
    sqlanvil_columns_removed
  );
END IF;

${this.alterTableAddColumnsSql(qualifiedTargetTableName)}
`;
        break;
      case sqlanvil.OnSchemaChange.SYNCHRONIZE:
        const uniqueKeys = table.uniqueKey || [];
        sql += `
SET sqlanvil_invalid_removed_columns = (
  SELECT IFNULL(ARRAY_AGG(col), []) FROM UNNEST(sqlanvil_columns_removed) AS col WHERE col IN UNNEST(${JSON.stringify(uniqueKeys)})
);

IF ARRAY_LENGTH(sqlanvil_invalid_removed_columns) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Cannot drop columns %T as they are part of the unique key for table ${qualifiedTargetTableName}",
    sqlanvil_invalid_removed_columns
  );
END IF;

IF ARRAY_LENGTH(sqlanvil_columns_removed) > 0 THEN
  EXECUTE IMMEDIATE (
    "ALTER TABLE ${qualifiedTargetTableName} " ||
    (
      SELECT STRING_AGG(FORMAT("DROP COLUMN IF EXISTS %s", col), ", ")
      FROM UNNEST(sqlanvil_columns_removed) AS col
    )
  );
END IF;

${this.alterTableAddColumnsSql(qualifiedTargetTableName)}
`;
        break;
    }
    return sql;
  }

  private alterTableAddColumnsSql(qualifiedTargetTableName: string): string {
    return `IF ARRAY_LENGTH(sqlanvil_columns_added) > 0 THEN
  EXECUTE IMMEDIATE (
    "ALTER TABLE ${qualifiedTargetTableName} " ||
    (
      SELECT STRING_AGG(FORMAT("ADD COLUMN IF NOT EXISTS %s %s", column_info.column_name, column_info.data_type), ", ")
      FROM UNNEST(sqlanvil_columns_added) AS column_info
    )
  );
END IF;`;
  }

  private prepareDynamicColumnsSql(table: sqlanvil.ITable): string {
    let sql = `
-- Prepare dynamic column lists for DML.
SET sqlanvil_columns_list = (
  SELECT STRING_AGG(FORMAT("\`%s\`", column_info.column_name), ", ")
  FROM UNNEST(sqlanvil_temp_table_columns) AS column_info
);`;

    if (this.isMergeStrategy(table)) {
      sql += `
SET sqlanvil_columns_merge = (
  SELECT STRING_AGG(FORMAT("\`%s\` = S.\`%s\`", column_info.column_name, column_info.column_name), ", ")
  FROM UNNEST(sqlanvil_temp_table_columns) AS column_info
);`;
    }

    return sql;
  }

  private cleanupSql(emptyTempTableName: string): string {
    return `
-- Cleanup empty temp table
DROP TABLE IF EXISTS ${emptyTempTableName};
    `;
  }

  private incrementalSchemaChangeBody(
    table: sqlanvil.ITable,
    qualifiedTargetTableName: string,
    emptyTempTableTarget: sqlanvil.ITarget,
    preOpTasks: Task[] = [],
    postOpTasks: Task[] = [],
  ): string {
    const emptyTempTableName = this.resolveTarget(emptyTempTableTarget);
    const query = this.getIncrementalQuery(table);
    const coreBody = [
      this.declareSchemaChangeVariablesSql(table),
      this.createEmptyTempTableSql(emptyTempTableName, query),
      this.compareSchemasSql(table.target, emptyTempTableTarget),
      this.cleanupSql(emptyTempTableName),
      this.applySchemaChangeStrategySql(table, qualifiedTargetTableName),
      this.prepareDynamicColumnsSql(table),
      this.getIncrementalDmlStatement(table),
    ].join("\n\n");

    const preOpsSql = terminateStatements(preOpTasks.map((t) => t.getStatement()));
    const postOpsSql = terminateStatements(postOpTasks.map((t) => t.getStatement()));

    // Whenever user-provided operations share the procedure scope, the core body is wrapped in its
    // own block. This places its DECLARE statements at the start of a block when they follow
    // pre-operations, and takes the internal variables out of scope before post-operations run.
    // Post-operations are left unwrapped so that comment-only operations don't produce an empty
    // (invalid) BEGIN...END block.
    const bodyParts: string[] = [];
    if (preOpsSql) {
      bodyParts.push(preOpsSql);
    }
    bodyParts.push(preOpsSql || postOpsSql ? `BEGIN\n${coreBody}\nEND;` : coreBody);
    if (postOpsSql) {
      bodyParts.push(postOpsSql);
    }

    return bodyParts.join("\n\n");
  }

  private createOrReplace(table: sqlanvil.ITable) {
    const options = [];
    if (table.bigquery && table.bigquery.partitionBy && table.bigquery.partitionExpirationDays) {
      options.push(`partition_expiration_days=${table.bigquery.partitionExpirationDays}`);
    }
    if (table.bigquery && table.bigquery.partitionBy && table.bigquery.requirePartitionFilter) {
      options.push(`require_partition_filter=${table.bigquery.requirePartitionFilter}`);
    }
    if (table.bigquery && table.bigquery.additionalOptions) {
      for (const [optionName, optionValue] of Object.entries(table.bigquery.additionalOptions)) {
        options.push(`${optionName}=${optionValue}`);
      }
    }

    return `create or replace ${table.materialized ? "materialized " : ""}${this.tableTypeAsSql(
      this.baseTableType(table.enumType),
    )} ${this.resolveTarget(table.target)} ${
      table.bigquery && table.bigquery.partitionBy
        ? `partition by ${table.bigquery.partitionBy} `
        : ""
    }${
      table.bigquery && table.bigquery.clusterBy && table.bigquery.clusterBy.length > 0
        ? `cluster by ${table.bigquery.clusterBy.join(", ")} `
        : ""
    }${options.length > 0 ? `OPTIONS(${options.join(",")})` : ""}as ${table.query}`;
  }

  private createOrReplaceView(target: sqlanvil.ITarget, query: string) {
    return `
      create or replace view ${this.resolveTarget(target)} as ${query}`;
  }

  /**
   * Which DML an incremental append runs, by strategy (upstream #2195).
   *
   * MERGE (and the unspecified default) is what sqlanvil has always done: match on uniqueKey, or
   * plain INSERT when there is no key. INSERT_OVERWRITE replaces whole partitions instead — the
   * right shape when a run recomputes a date range rather than upserting rows.
   *
   * Without `columns` the statement runs inside the onSchemaChange procedure: the incremental
   * query is staged in a temp table, and the DML is built from the post-ALTER column list
   * (sqlanvil_columns_list / sqlanvil_columns_merge) and run with EXECUTE IMMEDIATE.
   */
  private getIncrementalDmlStatement(table: sqlanvil.ITable, columns?: string[]): string {
    switch (table.incrementalStrategy) {
      case sqlanvil.IncrementalStrategy.INSERT_OVERWRITE:
        return this.withTempStagingTable(this.getIncrementalQuery(table), (stagingTable) =>
          this.insertOverwrite(table.target, columns, stagingTable, table.bigquery),
        );
      case sqlanvil.IncrementalStrategy.MERGE:
      default:
        return this.isMergeStrategy(table)
          ? this.getMergeIncrementalDmlStatement(table, columns)
          : this.getInsertIncrementalDmlStatement(table, columns);
    }
  }

  private getMergeIncrementalDmlStatement(table: sqlanvil.ITable, columns?: string[]): string {
    const incrementalQuery = this.getIncrementalQuery(table);
    if (!columns) {
      return this.withTempStagingTable(incrementalQuery, (stagingTable) =>
        this.mergeInto(table.target, undefined, stagingTable, table.uniqueKey, table.bigquery),
      );
    }
    return this.mergeInto(
      table.target,
      columns,
      `(${incrementalQuery}\n)`,
      table.uniqueKey,
      table.bigquery,
    );
  }

  private getInsertIncrementalDmlStatement(table: sqlanvil.ITable, columns?: string[]): string {
    const incrementalQuery = this.getIncrementalQuery(table);
    if (!columns) {
      return this.withTempStagingTable(incrementalQuery, (stagingTable) =>
        this.insertInto(table.target, undefined, stagingTable),
      );
    }
    return this.insertInto(table.target, columns, `(${incrementalQuery}\n) as insertions`);
  }

  private escapeSqlString(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private withTempStagingTable(query: string, buildBody: (stagingTable: string) => string): string {
    const stagingTable = `\`staging_table_temp_${this.uniqueIdGenerator()}\``;
    return `CREATE OR REPLACE TEMP TABLE ${stagingTable} AS (
  ${query}
);

${buildBody(stagingTable)}

-- Cleanup staging table
DROP TABLE IF EXISTS ${stagingTable};`;
  }

  private colsList(columns: string[] | undefined): string {
    return columns
      ? columns.map((column) => `\`${column}\``).join(",")
      : '""" || sqlanvil_columns_list || """';
  }

  /**
   * Resolves the target for use in a DML statement. When `columns` is undefined the statement is
   * built dynamically inside an EXECUTE IMMEDIATE string literal, so the target is escaped.
   */
  private resolveDmlTarget(target: sqlanvil.ITarget, columns: string[] | undefined): string {
    const resolvedTarget = this.resolveTarget(target);
    return columns ? resolvedTarget : this.escapeSqlString(resolvedTarget);
  }

  private buildIncrementalPredicatesString(incrementalPredicates?: string[] | null): string {
    const valid = incrementalPredicates?.filter((p) => p.trim() !== "") ?? [];
    if (valid.length === 0) {
      return "";
    }
    return `and ${valid.map((p) => `(${p})`).join(" and ")}`;
  }

  /**
   * INSERT_OVERWRITE: stage the incremental query, then replace every partition the staged rows
   * touch. `MERGE … ON FALSE` is the BigQuery idiom for it — nothing ever matches, so
   * NOT MATCHED BY SOURCE deletes the destination rows in those partitions and NOT MATCHED BY
   * TARGET inserts the staged ones, atomically.
   *
   * Requires `bigquery.partitionBy`; without a partition column there is nothing to scope the
   * delete to and this would truncate the table. `incremental_table.ts` rejects that at compile
   * time, so reaching here without one is a bug rather than a user error.
   */
  private insertOverwrite(
    target: sqlanvil.ITarget,
    columns: string[] | undefined,
    stagingTable: string,
    bigquery?: sqlanvil.IBigQueryOptions,
  ): string {
    const cols = this.colsList(columns);
    const partitionBy = bigquery?.partitionBy;
    const updatePartitionFilter = bigquery?.updatePartitionFilter;
    const incrementalPredicatesString = this.buildIncrementalPredicatesString(
      bigquery?.incrementalPredicates,
    );
    const resolvedTarget = this.resolveDmlTarget(target, columns);
    // Inside EXECUTE IMMEDIATE the partition list is a query parameter (upstream #2328 was this
    // name failing to resolve in the dynamic statement).
    const partitionsVar = columns
      ? "sqlanvil_partitions_for_replacement"
      : "@sqlanvil_partitions_for_replacement";
    const notMatchedBySourceCondition = `${partitionBy} IN UNNEST(${partitionsVar})${
      updatePartitionFilter ? ` and T.${updatePartitionFilter}` : ""
    }${incrementalPredicatesString ? ` ${incrementalPredicatesString}` : ""}`;

    const mergeSql = `MERGE ${resolvedTarget} T
  USING ${stagingTable} S
  ON FALSE
  WHEN NOT MATCHED BY SOURCE AND ${
    columns ? notMatchedBySourceCondition : this.escapeSqlString(notMatchedBySourceCondition)
  }
  THEN
    DELETE
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (${cols}) VALUES (${cols})`;

    return `BEGIN
  DECLARE sqlanvil_partitions_for_replacement DEFAULT (
    ARRAY(
      SELECT DISTINCT ${partitionBy}
      FROM ${stagingTable}
      WHERE ${partitionBy} IS NOT NULL
    )
  );

  ${
    columns
      ? mergeSql
      : `EXECUTE IMMEDIATE ("""${mergeSql}""")\n  USING sqlanvil_partitions_for_replacement AS sqlanvil_partitions_for_replacement`
  };
END;`;
  }

  private mergeInto(
    target: sqlanvil.ITarget,
    columns: string[] | undefined,
    source: string,
    uniqueKey: string[],
    bigquery?: sqlanvil.IBigQueryOptions,
  ) {
    const cols = this.colsList(columns);
    const updateSet = columns
      ? columns.map((column) => `\`${column}\` = S.\`${column}\``).join(",")
      : '""" || sqlanvil_columns_merge || """';
    const updatePartitionFilter = bigquery?.updatePartitionFilter;
    const incrementalPredicatesString = this.buildIncrementalPredicatesString(
      bigquery?.incrementalPredicates,
    );
    const resolvedTarget = this.resolveDmlTarget(target, columns);
    const onCondition = `${uniqueKey.map((uniqueKeyCol) => `T.${uniqueKeyCol} = S.${uniqueKeyCol}`).join(` and `)}
  ${updatePartitionFilter ? `and T.${updatePartitionFilter}` : ""}${
    incrementalPredicatesString ? `\n  ${incrementalPredicatesString}` : ""
  }`;
    const dml = `
merge ${resolvedTarget} T
using ${source} S
on ${columns ? onCondition : this.escapeSqlString(onCondition)}
when matched then
  update set ${updateSet}
when not matched then
  insert (${cols}) values (${cols})`;

    return columns ? dml : `EXECUTE IMMEDIATE ("""${dml}""");`;
  }
}
