import { BigQueryExecutionSql } from "sa/cli/api/dbadapters/bigquery_execution_sql";
import { PostgresExecutionSql } from "sa/cli/api/dbadapters/postgres_execution_sql";
import { concatenateQueries, Tasks } from "sa/cli/api/dbadapters/tasks";
import { ErrorWithCause } from "sa/common/errors/errors";
import { sqlanvil } from "sa/protos/ts";

export type QueryOrAction = string | sqlanvil.Table | sqlanvil.Operation | sqlanvil.Assertion;

export interface IValidationQuery {
  query?: string;
  incremental?: boolean;
}

export interface IExecutionSql {
  resolveTarget(target: sqlanvil.ITarget): string;
  publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks;
  assertTasks(
    assertion: sqlanvil.IAssertion,
    projectConfig: sqlanvil.IProjectConfig
  ): Tasks;
  dropIfExists(target: sqlanvil.ITarget, type: sqlanvil.TableMetadata.Type): string;
}

export class ExecutionSql implements IExecutionSql {
  private readonly delegate: IExecutionSql;

  constructor(
    private readonly project: sqlanvil.IProjectConfig,
    private readonly sqlanvilCoreVersion: string,
    uniqueIdGenerator?: () => string
  ) {
    const warehouse = (project.warehouse || "bigquery").toLowerCase();
    if (warehouse === "postgres" || warehouse === "supabase") {
      this.delegate = new PostgresExecutionSql(project, sqlanvilCoreVersion, uniqueIdGenerator);
    } else {
      this.delegate = new BigQueryExecutionSql(project, sqlanvilCoreVersion, uniqueIdGenerator);
    }
  }

  public resolveTarget(target: sqlanvil.ITarget): string {
    return this.delegate.resolveTarget(target);
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    return this.delegate.publishTasks(table, runConfig, tableMetadata);
  }

  public createTableTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): sqlanvil.IExecutionTask[] {
    return table.disabled ? [] : this.publishTasks(table, runConfig, tableMetadata).build();
  }

  public createOperationTasks(operation: sqlanvil.IOperation): sqlanvil.IExecutionTask[] {
    return operation.disabled
      ? []
      : operation.queries.map(statement =>
          sqlanvil.ExecutionTask.create({ type: "statement", statement })
        );
  }

  public createAssertionTasks(assertion: sqlanvil.IAssertion): sqlanvil.IExecutionTask[] {
    return assertion.disabled ? [] : this.assertTasks(assertion, this.project).build();
  }

  public assertTasks(
    assertion: sqlanvil.IAssertion,
    projectConfig: sqlanvil.IProjectConfig
  ): Tasks {
    return this.delegate.assertTasks(assertion, projectConfig);
  }

  public dropIfExists(target: sqlanvil.ITarget, type: sqlanvil.TableMetadata.Type): string {
    return this.delegate.dropIfExists(target, type);
  }
}

export function collectEvaluationQueries(
  queryOrAction: QueryOrAction,
  concatenate: boolean,
  queryModifier: (mod: string) => string = (q: string) => q
): IValidationQuery[] {
  const validationQueries = new Array<IValidationQuery>();
  if (typeof queryOrAction === "string") {
    validationQueries.push({ query: queryModifier(queryOrAction) });
  } else {
    try {
      if (queryOrAction instanceof sqlanvil.Table) {
        if (queryOrAction.enumType === sqlanvil.TableType.INCREMENTAL) {
          const incrementalTableQueries = queryOrAction.incrementalPreOps.concat(
            queryOrAction.incrementalQuery,
            queryOrAction.incrementalPostOps
          );
          if (concatenate) {
            validationQueries.push({
              query: concatenateQueries(incrementalTableQueries, queryModifier),
              incremental: true
            });
          } else {
            incrementalTableQueries.forEach(q =>
              validationQueries.push({ query: queryModifier(q), incremental: true })
            );
          }
        }
        const tableQueries = queryOrAction.preOps.concat(
          queryOrAction.query,
          queryOrAction.postOps
        );
        if (concatenate) {
          validationQueries.push({
            query: concatenateQueries(tableQueries, queryModifier)
          });
        } else {
          tableQueries.forEach(q => validationQueries.push({ query: queryModifier(q) }));
        }
      } else if (queryOrAction instanceof sqlanvil.Operation) {
        if (concatenate) {
          validationQueries.push({
            query: concatenateQueries(queryOrAction.queries, queryModifier)
          });
        } else {
          queryOrAction.queries.forEach(q => validationQueries.push({ query: queryModifier(q) }));
        }
      } else if (queryOrAction instanceof sqlanvil.Assertion) {
        validationQueries.push({ query: queryModifier(queryOrAction.query) });
      } else {
        throw new Error("Unrecognized evaluate type.");
      }
    } catch (e) {
      throw new ErrorWithCause(`Error building tasks for evaluation. ${e.message}`, e);
    }
  }
  return validationQueries
    .map(validationQuery => ({ query: validationQuery.query.trim(), ...validationQuery }))
    .filter(validationQuery => !!validationQuery.query);
}
