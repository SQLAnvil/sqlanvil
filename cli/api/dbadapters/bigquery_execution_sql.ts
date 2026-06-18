import * as semver from "semver";

import { IExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { resolveExportUri } from "sa/cli/api/dbadapters/export_uri";
import { concatenateQueries, Task, Tasks } from "sa/cli/api/dbadapters/tasks";
import { ErrorWithCause } from "sa/common/errors/errors";
import { CompilationSql } from "sa/core/compilation_sql";
import { tableTypeEnumToString } from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

export class BigQueryExecutionSql implements IExecutionSql {
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

  public insertInto(target: sqlanvil.ITarget, columns: string[], query: string) {
    return `	
insert into ${this.resolveTarget(target)}	
(${columns.join(",")})	
select ${columns.join(",")}	
from (${query}) as insertions`;
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

  public resolveTarget(target: sqlanvil.ITarget) {
    return this.CompilationSql.resolveTarget(target);
  }

  public getIncrementalQuery(table: sqlanvil.ITable): string {
    return this.where(table.incrementalQuery || table.query, table.where);
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    const tasks = new Tasks();

    this.preOps(table, runConfig, tableMetadata).forEach(statement => tasks.add(statement));

    const baseTableType = this.baseTableType(table.enumType);
    if (tableMetadata && tableMetadata.type !== baseTableType) {
      tasks.add(
        Task.statement(this.dropIfExists(table.target, this.oppositeTableType(baseTableType)))
      );
    }

    if (table.enumType === sqlanvil.TableType.INCREMENTAL) {
      if (!this.shouldWriteIncrementally(table, runConfig, tableMetadata)) {
        tasks.add(Task.statement(this.createOrReplace(table)));
      } else {
        const onSchemaChange = table.onSchemaChange ?? sqlanvil.OnSchemaChange.IGNORE;
        switch (onSchemaChange) {
          case sqlanvil.OnSchemaChange.FAIL:
          case sqlanvil.OnSchemaChange.EXTEND:
          case sqlanvil.OnSchemaChange.SYNCHRONIZE:
            this.buildIncrementalSchemaChangeTasks(tasks, table);
            // Fall through to run the static DML after the procedure alters the schema
          case sqlanvil.OnSchemaChange.IGNORE:
          default:
            tasks.add(
              Task.statement(
                table.uniqueKey && table.uniqueKey.length > 0
                  ? this.mergeInto(
                      table.target,
                      tableMetadata?.fields.map(f => f.name),
                      this.getIncrementalQuery(table),
                      table.uniqueKey,
                      table.bigquery && table.bigquery.updatePartitionFilter
                    )
                  : this.insertInto(
                      table.target,
                      tableMetadata?.fields.map(f => f.name).map(column => `\`${column}\``),
                      this.getIncrementalQuery(table)
                    )
              )
            );
            break;
        }
      }
    } else {
      tasks.add(Task.statement(this.createOrReplace(table)));
    }

    this.postOps(table, runConfig, tableMetadata).forEach(statement => tasks.add(statement));

    return tasks.concatenate();
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

  private buildIncrementalSchemaChangeTasks(tasks: Tasks, table: sqlanvil.ITable) {
    const uniqueId = this.uniqueIdGenerator();

    const emptyTempTableTarget = {
      ...table.target,
      name: `${table.target.name}_sa_temp_${uniqueId}_empty`
    };

    const procedureName = this.createProcedureName(table.target, uniqueId);
    const procedureBody = this.incrementalSchemaChangeBody(
      table,
      this.resolveTarget(table.target),
      emptyTempTableTarget
    );

    const createProcedureSql = `CREATE OR REPLACE PROCEDURE ${procedureName}()
OPTIONS(strict_mode=false)
BEGIN
${procedureBody}
END;`;

    const callProcedureSql = this.safeCallAndDropProcedure(
      procedureName,
      this.resolveTarget(emptyTempTableTarget)
    );
    tasks.add(Task.statement(createProcedureSql));
    tasks.add(Task.statement(callProcedureSql));
  }

  private createProcedureName(target: sqlanvil.ITarget, uniqueId: string): string {
    return this.resolveTarget({
      ...target,
      name: `sa_osc_${uniqueId}`
    });
  }

  private safeCallAndDropProcedure(
    procedureName: string,
    emptyTempTableName: string
  ): string {
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
  SELECT * FROM (${query}) AS insertions LIMIT 0
);`;
  }

  private compareSchemasSql(
    target: sqlanvil.ITarget,
    emptyTempTableTarget: sqlanvil.ITarget
  ): string {
    return `
-- Compare schemas
DECLARE sqlanvil_columns ARRAY<STRING>;
DECLARE temp_table_columns ARRAY<STRUCT<column_name STRING, data_type STRING>>;
DECLARE columns_added ARRAY<STRUCT<column_name STRING, data_type STRING>>;
DECLARE columns_removed ARRAY<STRING>;

SET sqlanvil_columns = (
  SELECT IFNULL(ARRAY_AGG(DISTINCT column_name), [])
  FROM \`${target.database}.${target.schema}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE table_name = '${target.name}'
);

SET temp_table_columns = (
  SELECT IFNULL(ARRAY_AGG(STRUCT(column_name, data_type)), [])
  FROM \`${emptyTempTableTarget.database}.${emptyTempTableTarget.schema}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE table_name = '${emptyTempTableTarget.name}'
);

SET columns_added = (
  SELECT IFNULL(ARRAY_AGG(column_info), [])
  FROM UNNEST(temp_table_columns) AS column_info
  WHERE column_info.column_name NOT IN UNNEST(sqlanvil_columns)
);
SET columns_removed = (
  SELECT IFNULL(ARRAY_AGG(column_name), [])
  FROM UNNEST(sqlanvil_columns) AS column_name
  WHERE column_name NOT IN (SELECT col.column_name FROM UNNEST(temp_table_columns) AS col)
);`;
  }

  private applySchemaChangeStrategySql(
    table: sqlanvil.ITable,
    qualifiedTargetTableName: string
  ): string {
    const onSchemaChange = table.onSchemaChange || sqlanvil.OnSchemaChange.IGNORE;
    let sql = `
-- Apply schema change strategy (${sqlanvil.OnSchemaChange[onSchemaChange]}).`;

    switch (onSchemaChange) {
      case sqlanvil.OnSchemaChange.FAIL:
        sql += `
IF ARRAY_LENGTH(columns_added) > 0 OR ARRAY_LENGTH(columns_removed) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Schema mismatch defined by on_schema_change = 'FAIL'. Added columns: %T, removed columns: %T",
    columns_added,
    columns_removed
  );
END IF;
`;
        break;
      case sqlanvil.OnSchemaChange.EXTEND:
        sql += `
IF ARRAY_LENGTH(columns_removed) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Column removals are not allowed when on_schema_change = 'EXTEND'. Removed columns: %T",
    columns_removed
  );
END IF;

${this.alterTableAddColumnsSql(qualifiedTargetTableName)}
`;
        break;
      case sqlanvil.OnSchemaChange.SYNCHRONIZE:
        const uniqueKeys = table.uniqueKey || [];
        sql += `
DECLARE invalid_removed_columns ARRAY<STRING>;
SET invalid_removed_columns = (
  SELECT IFNULL(ARRAY_AGG(col), []) FROM UNNEST(columns_removed) AS col WHERE col IN UNNEST(${JSON.stringify(uniqueKeys)})
);

IF ARRAY_LENGTH(invalid_removed_columns) > 0 THEN
  RAISE USING MESSAGE = FORMAT(
    "Cannot drop columns %T as they are part of the unique key for table ${qualifiedTargetTableName}",
    invalid_removed_columns
  );
END IF;

IF ARRAY_LENGTH(columns_removed) > 0 THEN
  EXECUTE IMMEDIATE (
    "ALTER TABLE ${qualifiedTargetTableName} " ||
    (
      SELECT STRING_AGG(FORMAT("DROP COLUMN IF EXISTS %s", col), ", ")
      FROM UNNEST(columns_removed) AS col
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
    return `IF ARRAY_LENGTH(columns_added) > 0 THEN
  EXECUTE IMMEDIATE (
    "ALTER TABLE ${qualifiedTargetTableName} " ||
    (
      SELECT STRING_AGG(FORMAT("ADD COLUMN IF NOT EXISTS %s %s", column_info.column_name, column_info.data_type), ", ")
      FROM UNNEST(columns_added) AS column_info
    )
  );
END IF;`;
  }

  private cleanupSql(emptyTempTableName: string): string {
    return `
-- Cleanup temporary tables.
DROP TABLE IF EXISTS ${emptyTempTableName};
    `;
  }

  private incrementalSchemaChangeBody(
    table: sqlanvil.ITable,
    qualifiedTargetTableName: string,
    emptyTempTableTarget: sqlanvil.ITarget
  ): string {
    const emptyTempTableName = this.resolveTarget(emptyTempTableTarget);
    const query = this.getIncrementalQuery(table);
    const statements: string[] = [
      this.createEmptyTempTableSql(emptyTempTableName, query),
      this.compareSchemasSql(
        table.target,
        emptyTempTableTarget
      ),
      this.applySchemaChangeStrategySql(table, qualifiedTargetTableName),
      this.cleanupSql(emptyTempTableName)
    ];

    return statements.join("\n\n");
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
      this.baseTableType(table.enumType)
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

  private mergeInto(
    target: sqlanvil.ITarget,
    columns: string[],
    query: string,
    uniqueKey: string[],
    updatePartitionFilter: string
  ) {
    const backtickedColumns = columns.map(column => `\`${column}\``);
    return `
merge ${this.resolveTarget(target)} T
using (${query}
) S
on ${uniqueKey.map(uniqueKeyCol => `T.${uniqueKeyCol} = S.${uniqueKeyCol}`).join(` and `)}
  ${updatePartitionFilter ? `and T.${updatePartitionFilter}` : ""}
when matched then
  update set ${columns.map(column => `\`${column}\` = S.${column}`).join(",")}
when not matched then
  insert (${backtickedColumns.join(",")}) values (${backtickedColumns.join(",")})`;
  }
}
