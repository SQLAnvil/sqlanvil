import EventEmitter from "events";

import { substituteConnectionCredentials } from "sa/cli/api/commands/connection_credentials";
import { runScript, ScriptRunArgs } from "sa/cli/api/commands/script_run";
import * as dbadapters from "sa/cli/api/dbadapters";
import { IBigQueryExecutionOptions } from "sa/cli/api/dbadapters/bigquery";
import { BigQueryExtractArgs, runBigQueryExtract } from "sa/cli/api/dbadapters/bigquery_extract";
import {
  DuckdbExportArgs,
  resolveLocalLocation,
  runDuckdbExport,
} from "sa/cli/api/dbadapters/duckdb_export";
import { DuckdbImportArgs, runDuckdbImport } from "sa/cli/api/dbadapters/duckdb_import";
import { MysqlExtractArgs, runMysqlExtract } from "sa/cli/api/dbadapters/mysql_extract";
import { dryRunValidationQueryKey } from "sa/cli/api/utils/dry_run_validation";
import { mapErrorPositions } from "sa/cli/api/utils/error_parsing";
import {
  CREATE_SCHEMA_WRAPPER_LINE_OFFSET,
  wrapWithCreateSchemaIfNotExists,
} from "sa/cli/api/utils/query_transforms";
import { Timer } from "sa/cli/api/utils/timer";
import { Flags } from "sa/common/flags";
import { retry } from "sa/common/promises";
import { deepClone, equals } from "sa/common/protos";
import { targetStringifier } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";

const CANCEL_EVENT = "jobCancel";
const flags = {
  runnerNotificationPeriodMillis: Flags.number("runner-notification-period-millis", 5000),
};

const isSuccessfulAction = (actionResult: sqlanvil.IActionResult) =>
  actionResult.status === sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL ||
  actionResult.status === sqlanvil.ActionResult.ExecutionStatus.DISABLED;

export interface IExecutedAction {
  executionAction: sqlanvil.IExecutionAction;
  actionResult: sqlanvil.IActionResult;
}

export interface IExecutionOptions {
  bigquery?: {
    jobPrefix?: string;
    actionRetryLimit?: number;
    dryRun?: boolean;
    labels?: { [label: string]: string };
  };
  // Source-connection credentials (from .df-credentials.json's `connections` map) used
  // to substitute `${SA_CONN:<conn>:user|password}` placeholders in FDW-bridge statements
  // at execution time. Secrets are applied only to the string sent to the warehouse — the
  // in-memory execution graph keeps the placeholders.
  connectionCredentials?: { [name: string]: any };
  // The write-warehouse connection (Postgres/Supabase) used by the runner-side DuckDB
  // exporter to ATTACH the source database. Only needed when a project has export actions.
  warehouseConnection?: any;
  // Object-store credentials for the DuckDB exporter, keyed by scheme (from
  // `.df-credentials.json`'s `storage` section). Not needed for local:// exports.
  storageCredentials?: { [scheme: string]: { [key: string]: string } };
  // Seam for tests to inject a fake exporter; defaults to runDuckdbExport.
  duckdbExport?: (args: DuckdbExportArgs) => Promise<{ destination: string }>;
  // Seam for tests to inject a fake importer; defaults to runDuckdbImport.
  duckdbImport?: (args: DuckdbImportArgs) => Promise<{ source: string }>;
  // Seam for tests to inject a fake extractor; defaults to runBigQueryExtract.
  bigQueryExtract?: (args: BigQueryExtractArgs) => Promise<{ rowCount: number }>;
  // Seam for tests to inject a fake MySQL extractor; defaults to runMysqlExtract.
  mysqlExtract?: (args: MysqlExtractArgs) => Promise<{ rowCount: number }>;
  // Seam for tests to inject a fake script runner; defaults to runScript.
  scriptRun?: (args: ScriptRunArgs) => Promise<{ exitCode: number }>;
  // Absolute project directory — the cwd for script actions (and the base for their relative
  // paths). Only needed when a project has script actions.
  projectDir?: string;
  // BigQuery dry runs: the SELECT query (with pre-operations) of each table, view and assertion,
  // keyed by dryRunValidationQueryKey(target). A task wrapped in a script creating its missing
  // target dataset is only syntax-checked by a dry run, so this query is dry-run after it.
  dryRunValidationQueries?: Map<string, string>;
}

export type CancelReason = "timeout" | "user" | "cancellation";

/**
 * Whether the action writes to its target, so that the target dataset must exist. Operations only
 * do if they're declared with `hasOutput: true`; otherwise their target is just a name, and their
 * SQL may write anywhere (or nowhere). Exports write files, and scripts and extracts run
 * runner-side, so none of them creates its target dataset.
 */
function writesToTarget(action: sqlanvil.IExecutionAction): boolean {
  switch (action.type) {
    case "table":
    case "assertion":
    case "import":
      return true;
    case "operation":
      return !!action.hasOutput;
    default:
      return false;
  }
}

/** Whether the task is SQL sent to the warehouse, which can be wrapped in a script. */
function isWarehouseStatement(task: sqlanvil.IExecutionTask): boolean {
  return task.type === "statement" || task.type === "operation";
}

/** A target dataset that doesn't exist yet. */
interface IMissingSchema {
  // Unset if the action's target has no database and there's no default database, in which case
  // BigQuery uses the project of the credentials.
  database: string | undefined;
  schema: string;
}

export function run(
  dbadapter: dbadapters.IDbAdapter,
  graph: sqlanvil.IExecutionGraph,
  executionOptions: IExecutionOptions = {},
  partiallyExecutedRunResult: sqlanvil.IRunResult = {},
  runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get(),
): Runner {
  return new Runner(
    dbadapter,
    graph,
    executionOptions,
    partiallyExecutedRunResult,
    runnerNotificationPeriodMillis,
  ).execute();
}

export class Runner {
  public static create(
    dbadapter: dbadapters.IDbAdapter,
    graph: sqlanvil.IExecutionGraph,
    options: IExecutionOptions = {},
    runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get(),
  ): Runner {
    return new Runner(dbadapter, graph, options, {}, runnerNotificationPeriodMillis);
  }

  public static resume(
    dbadapter: dbadapters.IDbAdapter,
    graph: sqlanvil.IExecutionGraph,
    runResult: sqlanvil.IRunResult,
    runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get(),
  ): Runner {
    return new Runner(dbadapter, graph, {}, runResult, runnerNotificationPeriodMillis);
  }

  private readonly warehouseStateByTarget: Map<string, sqlanvil.ITableMetadata>;

  private readonly allActionTargets: Set<string>;
  private readonly runResult: sqlanvil.IRunResult;
  private readonly changeListeners: Array<(graph: sqlanvil.IRunResult) => void> = [];
  private readonly eEmitter: EventEmitter;
  private executedActionTargets: Set<string>;
  private successfullyExecutedActionTargets: Set<string>;
  private pendingActions: sqlanvil.IExecutionAction[];
  private lastNotificationTimestampMillis = 0;
  private stopped = false;
  private cancelled = false;
  private timeout: NodeJS.Timer;
  private timedOut = false;
  private executionTask: Promise<sqlanvil.IRunResult>;
  private skipReason: string = "";
  private readonly executionOptions: IExecutionOptions;
  // BigQuery creates missing datasets lazily (upstream #2408): in the same job as the first task
  // writing to them, so that the dataset gets the location of the data that task reads. Other
  // warehouses create every missing schema up front (prepareAllSchemas).
  private readonly lazySchemaCreation: boolean;
  private missingSchemas = new Map<string, IMissingSchema>();
  private schemaCreations = new Map<string, Promise<void>>();

  // Extracts are DAG roots, so an unfiltered run makes EVERY extract executable at once — each
  // holds a warehouse connection (Supabase's session pooler caps clients, e.g. 15) and buffers
  // source pages in memory, so unbounded fan-out exhausts the pooler and the heap. Cap them;
  // other action types are already throttled by the warehouse adapter's connection pool.
  private static readonly MAX_CONCURRENT_EXTRACTS = 4;
  private runningExtracts = 0;
  private readonly extractWaiters: Array<() => void> = [];

  private async acquireExtractSlot(): Promise<void> {
    if (this.runningExtracts < Runner.MAX_CONCURRENT_EXTRACTS) {
      this.runningExtracts++;
      return;
    }
    await new Promise<void>((resolve) => this.extractWaiters.push(resolve));
    this.runningExtracts++;
  }

  private releaseExtractSlot(): void {
    this.runningExtracts--;
    const next = this.extractWaiters.shift();
    if (next) {
      next();
    }
  }

  constructor(
    private readonly dbadapter: dbadapters.IDbAdapter,
    private readonly graph: sqlanvil.IExecutionGraph,
    executionOptions: IExecutionOptions = {},
    partiallyExecutedRunResult: sqlanvil.IRunResult = {},
    private readonly runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get(),
  ) {
    this.executionOptions = { projectDir: ".", ...executionOptions };
    this.lazySchemaCreation =
      (graph.projectConfig?.warehouse || "bigquery").toLowerCase() === "bigquery";
    this.runResult = {
      actions: [],
      ...partiallyExecutedRunResult,
    };
    this.allActionTargets = new Set<string>(
      graph.actions.map((action) => targetStringifier.stringify(action.target)),
    );
    this.warehouseStateByTarget = new Map<string, sqlanvil.ITableMetadata>();
    graph.warehouseState.tables?.forEach((tableMetadata) =>
      this.warehouseStateByTarget.set(
        targetStringifier.stringify(tableMetadata.target),
        tableMetadata,
      ),
    );
    this.executedActionTargets = new Set(
      this.runResult.actions
        .filter((action) => action.status !== sqlanvil.ActionResult.ExecutionStatus.RUNNING)
        .map((action) => targetStringifier.stringify(action.target)),
    );
    this.successfullyExecutedActionTargets = new Set<string>(
      this.runResult.actions
        .filter(isSuccessfulAction)
        .map((action) => targetStringifier.stringify(action.target)),
    );
    this.pendingActions = graph.actions.filter(
      (action) => !this.executedActionTargets.has(targetStringifier.stringify(action.target)),
    );
    this.eEmitter = new EventEmitter();
    // There could feasibly be thousands of listeners to this, 0 makes the limit infinite.
    this.eEmitter.setMaxListeners(0);
  }

  public onChange(listener: (graph: sqlanvil.IRunResult) => void): Runner {
    this.changeListeners.push(listener);
    return this;
  }

  public execute(): this {
    if (this.executionTask !== undefined) {
      throw new Error("Executor already started.");
    }
    this.executionTask = this.executeGraph();
    if (!!this.graph.runConfig && !!this.graph.runConfig.timeoutMillis) {
      const now = Date.now();
      const runStartMillis = this.runResult.timing?.startTimeMillis?.toNumber?.() || now;
      const elapsedTimeMillis = now - runStartMillis;
      const timeoutMillis = this.graph.runConfig.timeoutMillis - elapsedTimeMillis;
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        this.cancel("timeout");
      }, timeoutMillis);
    }
    return this;
  }

  public stop() {
    this.stopped = true;
  }

  public cancel(reason: CancelReason = "user") {
    if (!this.skipReason) {
      switch (reason) {
        case "timeout":
          this.skipReason = this.graph.runConfig?.timeoutMillis
            ? `Run timed out after ${this.graph.runConfig.timeoutMillis / 1000} seconds`
            : "Run timed out";
          break;
        case "user":
          this.skipReason = "Run cancelled";
          break;
        case "cancellation":
          this.skipReason = "Run cancelled before action started";
          break;
      }
    }
    this.cancelled = true;
    this.eEmitter.emit(CANCEL_EVENT, undefined, undefined);
  }

  public async result(): Promise<sqlanvil.IRunResult> {
    try {
      return await this.executionTask;
    } finally {
      if (!!this.timeout) {
        clearTimeout(this.timeout);
      }
    }
  }

  private notifyListeners() {
    if (Date.now() - this.runnerNotificationPeriodMillis < this.lastNotificationTimestampMillis) {
      return;
    }
    const runResultClone = deepClone(sqlanvil.RunResult, this.runResult);
    this.lastNotificationTimestampMillis = Date.now();
    this.changeListeners.forEach((listener) => listener(runResultClone));
  }

  private async executeGraph() {
    const timer = Timer.start(this.runResult.timing);

    this.runResult.status = sqlanvil.RunResult.ExecutionStatus.RUNNING;
    this.runResult.timing = timer.current();
    this.notifyListeners();

    if (this.lazySchemaCreation) {
      this.missingSchemas = await this.findMissingSchemas();
    } else if (this.runResult.actions.length === 0) {
      // If we're not resuming an existing run, prepare schemas.
      await this.prepareAllSchemas();
    }

    // Recursively execute all actions as they become executable.
    await this.executeAllActionsReadyForExecution();

    if (this.stopped) {
      return this.runResult;
    }

    this.runResult.timing = timer.end();

    this.runResult.status = sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL;
    if (this.timedOut) {
      this.runResult.status = sqlanvil.RunResult.ExecutionStatus.TIMED_OUT;
    } else if (this.cancelled) {
      this.runResult.status = sqlanvil.RunResult.ExecutionStatus.CANCELLED;
    } else if (
      this.runResult.actions.some(
        (action) => action.status === sqlanvil.ActionResult.ExecutionStatus.FAILED,
      )
    ) {
      this.runResult.status = sqlanvil.RunResult.ExecutionStatus.FAILED;
    }

    return this.runResult;
  }

  private async prepareAllSchemas() {
    // Work out all the schemas we are going to need to create first.
    const databaseSchemas = new Map<string, Set<string>>();
    this.graph.actions
      .filter((action) => !!action.target && !!action.target.schema)
      .forEach(({ target }) => {
        // This field may not be present for older versions of sqlanvil.
        const trueDatabase = target.database || this.graph.projectConfig.defaultDatabase;
        if (!databaseSchemas.has(trueDatabase)) {
          databaseSchemas.set(trueDatabase, new Set<string>());
        }
        databaseSchemas.get(trueDatabase).add(target.schema);
      });

    // Create all nonexistent schemas.
    await Promise.all(
      Array.from(databaseSchemas.entries()).map(async ([database, schemas]) => {
        const existingSchemas = new Set(await this.dbadapter.schemas(database));
        await Promise.all(
          Array.from(schemas)
            .filter((schema) => !existingSchemas.has(schema))
            .map((schema) =>
              this.dbadapter.createSchema(
                database,
                schema,
                this.graph.projectConfig?.defaultLocation || undefined,
              ),
            ),
        );
      }),
    );
  }

  /**
   * BigQuery: returns the target datasets of pending actions that don't exist yet, keyed by
   * `schemaKey()`. Nothing is created here; see `executeTaskCreatingMissingSchema()`.
   */
  private async findMissingSchemas(): Promise<Map<string, IMissingSchema>> {
    const databaseSchemas = new Map<string | undefined, Set<string>>();
    this.pendingActions
      .filter(
        (action) =>
          action.tasks.length > 0 &&
          !!action.target &&
          !!action.target.schema &&
          writesToTarget(action),
      )
      .forEach(({ target }) => {
        const trueDatabase = this.targetDatabase(target);
        if (!databaseSchemas.has(trueDatabase)) {
          databaseSchemas.set(trueDatabase, new Set<string>());
        }
        databaseSchemas.get(trueDatabase).add(target.schema);
      });

    const missingSchemas = new Map<string, IMissingSchema>();
    await Promise.all(
      Array.from(databaseSchemas.entries()).map(async ([database, schemas]) => {
        const existingSchemas = new Set(await this.dbadapter.schemas(database));
        Array.from(schemas)
          .filter((schema) => !existingSchemas.has(schema))
          .forEach((schema) =>
            missingSchemas.set(this.schemaKey({ database, schema }), { database, schema }),
          );
      }),
    );
    return missingSchemas;
  }

  private targetDatabase(target: sqlanvil.ITarget): string | undefined {
    // Either may be unset (e.g. no defaultProject in workflow_settings.yaml), in which case
    // BigQuery uses the project of the credentials.
    return target.database || this.graph.projectConfig?.defaultDatabase || undefined;
  }

  private schemaKey(target: sqlanvil.ITarget): string {
    return `${this.targetDatabase(target)}.${target.schema}`;
  }

  private async executeAllActionsReadyForExecution() {
    if (this.stopped) {
      return;
    }

    // If the run has been cancelled, cancel all pending actions.
    if (this.cancelled) {
      const allPendingActions = this.pendingActions;
      this.pendingActions = [];
      const skipErrorMessage = this.skipReason || "Run cancelled before action started";
      allPendingActions.forEach((pendingAction) => {
        let tasks: sqlanvil.ITaskResult[];
        if (pendingAction.tasks && pendingAction.tasks.length > 0) {
          tasks = pendingAction.tasks.map((_, i) => ({
            status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED,
            ...(i === 0 ? { errorMessage: skipErrorMessage } : {}),
          }));
        } else {
          tasks = [
            {
              status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED,
              errorMessage: skipErrorMessage,
            },
          ];
        }
        this.runResult.actions.push({
          target: pendingAction.target,
          status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
          tasks,
        });
      });
      this.notifyListeners();
      return;
    }

    const executableActions = [];
    const skippableActions = [];
    const stillPendingActions = [];
    for (const pendingAction of this.pendingActions) {
      if (
        // An action is executable if all dependencies either: do not exist in the graph, or
        // have executed successfully.
        pendingAction.dependencyTargets.every(
          (dependency) =>
            !this.allActionTargets.has(targetStringifier.stringify(dependency)) ||
            this.successfullyExecutedActionTargets.has(targetStringifier.stringify(dependency)),
        )
      ) {
        executableActions.push(pendingAction);
      } else if (
        // An action is skippable if it is not executable and all dependencies either: do not
        // exist in the graph, or have completed execution.
        pendingAction.dependencyTargets.every(
          (dependency) =>
            !this.allActionTargets.has(targetStringifier.stringify(dependency)) ||
            this.executedActionTargets.has(targetStringifier.stringify(dependency)),
        )
      ) {
        skippableActions.push(pendingAction);
      } else {
        // Otherwise, the action is still pending.
        stillPendingActions.push(pendingAction);
      }
    }
    this.pendingActions = stillPendingActions;

    await Promise.all([
      (async () => {
        skippableActions.forEach((skippableAction) => {
          this.runResult.actions.push({
            target: skippableAction.target,
            status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
            tasks: skippableAction.tasks.map(() => ({
              status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED,
            })),
          });
        });
        if (skippableActions.length > 0) {
          this.notifyListeners();
          await this.executeAllActionsReadyForExecution();
        }
      })(),
      Promise.all(
        executableActions.map(async (executableAction) => {
          const actionResult = await this.executeAction(executableAction);
          this.executedActionTargets.add(targetStringifier.stringify(executableAction.target));
          if (isSuccessfulAction(actionResult)) {
            this.successfullyExecutedActionTargets.add(
              targetStringifier.stringify(executableAction.target),
            );
          }
          await this.executeAllActionsReadyForExecution();
        }),
      ),
    ]);
  }

  private async executeAction(action: sqlanvil.IExecutionAction): Promise<sqlanvil.IActionResult> {
    let actionResult: sqlanvil.IActionResult = {
      target: action.target,
      tasks: [],
    };

    if (action.tasks.length === 0) {
      actionResult.status = sqlanvil.ActionResult.ExecutionStatus.DISABLED;
      this.runResult.actions.push(actionResult);
      this.notifyListeners();
      return actionResult;
    }

    const resumedActionResult = this.runResult.actions.find((existingActionResult) =>
      equals(sqlanvil.Target, existingActionResult.target, action.target),
    );
    if (resumedActionResult) {
      actionResult = resumedActionResult;
    } else {
      this.runResult.actions.push(actionResult);
    }
    actionResult.status = sqlanvil.ActionResult.ExecutionStatus.RUNNING;
    const timer = Timer.start(resumedActionResult?.timing);
    actionResult.timing = timer.current();
    this.notifyListeners();

    await this.dbadapter.withClientLock(async (client) => {
      // Start running tasks from the last executed task (if any), onwards.
      for (const task of action.tasks.slice(actionResult.tasks.length)) {
        if (
          actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING &&
          !this.stopped &&
          !this.cancelled
        ) {
          let schemaCreation = this.schemaCreationToWaitFor(action, task);
          while (schemaCreation !== undefined && !this.stopped && !this.cancelled) {
            await schemaCreation;
            schemaCreation = this.schemaCreationToWaitFor(action, task);
          }
        }
        if (this.stopped) {
          return actionResult;
        }
        if (
          actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING &&
          !this.cancelled
        ) {
          const taskStatus = await this.executeTaskCreatingMissingSchema(
            client,
            action,
            task,
            actionResult,
          );
          if (taskStatus === sqlanvil.TaskResult.ExecutionStatus.FAILED) {
            actionResult.status = sqlanvil.ActionResult.ExecutionStatus.FAILED;
          } else if (taskStatus === sqlanvil.TaskResult.ExecutionStatus.CANCELLED) {
            actionResult.status = sqlanvil.ActionResult.ExecutionStatus.CANCELLED;
          }
        } else {
          if (actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING) {
            actionResult.status = sqlanvil.ActionResult.ExecutionStatus.CANCELLED;
          }
          actionResult.tasks.push({
            status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED,
            errorMessage: this.skipReason || "Task skipped after cancellation",
          });
        }
      }
    });

    if (this.stopped) {
      return actionResult;
    }

    if (
      action.actionDescriptor &&
      // Only set metadata if we expect the action to complete in SUCCESSFUL state
      // (i.e. it must still be RUNNING, and not FAILED).
      actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING &&
      !(this.graph.runConfig && this.graph.runConfig.disableSetMetadata) &&
      // Only set metadata if not using BigQuery dry run
      !this.executionOptions.bigquery?.dryRun &&
      action.type === "table"
    ) {
      try {
        await this.dbadapter.setMetadata(action);
      } catch (e) {
        // TODO: Setting the metadata is not a task itself, so we have nowhere to surface this error cleanly.
        // For now, we can attach the error to the last task in the action so it gets
        // surfaced properly without ending the entire run, but also not failing silently.
        if (actionResult.tasks.length > 0) {
          actionResult.tasks[actionResult.tasks.length - 1].errorMessage =
            `Error setting metadata: ${e.message}`;
          actionResult.tasks[actionResult.tasks.length - 1].status =
            sqlanvil.TaskResult.ExecutionStatus.FAILED;
        }
        actionResult.status = sqlanvil.ActionResult.ExecutionStatus.FAILED;
      }
    }

    this.warehouseStateByTarget.delete(targetStringifier.stringify(action.target));

    if (actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING) {
      actionResult.status = sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL;
    }

    actionResult.timing = timer.end();
    this.notifyListeners();
    return actionResult;
  }

  private getBigQueryExecutionOptions(
    action: sqlanvil.IExecutionAction,
  ): sqlanvil.IBigQueryOptions & IBigQueryExecutionOptions {
    return {
      // Merge global run-level labels with action-level labels. Action-level labels take precedence.
      labels: {
        ...(this.executionOptions?.bigquery?.labels || {}),
        ...(action.actionDescriptor?.bigqueryLabels || {}),
      },
      actionRetryLimit: this.executionOptions?.bigquery?.actionRetryLimit,
      location: this.graph.projectConfig?.defaultLocation || undefined,
      jobPrefix: this.executionOptions?.bigquery?.jobPrefix,
      dryRun: this.executionOptions?.bigquery?.dryRun,
      reservation:
        action.actionDescriptor?.reservation || this.graph.projectConfig?.defaultReservation,
    };
  }

  /**
   * BigQuery: returns the target dataset to create in the same job as the given task, or null if
   * there's none. Every SQL task of an action that writes to its target is checked.
   */
  private missingSchemaToCreate(
    action: sqlanvil.IExecutionAction,
    task: sqlanvil.IExecutionTask,
  ): IMissingSchema | null {
    if (!this.lazySchemaCreation || !action.target?.schema || !writesToTarget(action)) {
      return null;
    }
    // Assertion tasks must stay single statements: their result is read from the job's rows,
    // and a script's result would be that of its last statement. Runner-side tasks (scripts,
    // exports, imports and extracts on other warehouses) aren't SQL sent to BigQuery.
    if (!isWarehouseStatement(task)) {
      return null;
    }
    return this.missingSchemas.get(this.schemaKey(action.target)) || null;
  }

  /**
   * Returns the job currently trying to create the given task's target dataset, if the task would
   * otherwise try to create it too. When it finishes, check again: another waiting task may have
   * become the next creator in the meantime.
   */
  private schemaCreationToWaitFor(
    action: sqlanvil.IExecutionAction,
    task: sqlanvil.IExecutionTask,
  ): Promise<void> | undefined {
    if (!this.missingSchemaToCreate(action, task)) {
      return undefined;
    }
    return this.schemaCreations.get(this.schemaKey(action.target));
  }

  /**
   * Executes the task. If its target dataset is still missing (BigQuery), the task is wrapped so
   * that the dataset is created in the same job. In a real run (not a dry run), other tasks writing
   * to the dataset wait for that job (see `schemaCreationToWaitFor()`): if it succeeds, they run
   * unwrapped; if it fails, the dataset may or may not have been created, so the next one tries to
   * create it.
   */
  private async executeTaskCreatingMissingSchema(
    client: dbadapters.IDbClient,
    action: sqlanvil.IExecutionAction,
    task: sqlanvil.IExecutionTask,
    actionResult: sqlanvil.IActionResult,
  ): Promise<sqlanvil.TaskResult.ExecutionStatus> {
    const options = { bigquery: this.getBigQueryExecutionOptions(action) };
    const missingSchema = this.missingSchemaToCreate(action, task);
    if (!missingSchema) {
      return this.executeTask(client, task, actionResult, options, action);
    }
    const statement = wrapWithCreateSchemaIfNotExists(
      missingSchema.database,
      missingSchema.schema,
      task.statement,
    );
    // Dry runs don't create the dataset, so there's no rate limit to protect, and nothing to wait
    // for: every task writing to the dataset is wrapped.
    if (this.executionOptions.bigquery?.dryRun) {
      return this.executeTask(
        client,
        task,
        actionResult,
        options,
        action,
        statement,
        this.executionOptions.dryRunValidationQueries?.get(dryRunValidationQueryKey(action.target)),
      );
    }

    // Registered without awaiting anything since `schemaCreationToWaitFor()` returned nothing, so
    // no other task can become the creator in between.
    const key = this.schemaKey(action.target);
    let release: () => void;
    this.schemaCreations.set(key, new Promise<void>((resolve) => (release = resolve)));
    try {
      const status = await this.executeTask(client, task, actionResult, options, action, statement);
      if (status === sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL) {
        this.missingSchemas.delete(key);
      }
      return status;
    } finally {
      this.schemaCreations.delete(key);
      release!();
    }
  }

  /**
   * Executes the given task. If set, `statementOverride` is executed instead of the task's
   * statement, and reported as its compiled SQL, so that error positions refer to what is shown.
   *
   * If `dryRunValidationQuery` is also set (in dry runs, for tasks wrapped in a script creating a
   * missing dataset, which BigQuery only syntax-checks), it is dry-run right after to fully check
   * the action's SELECT query within the same task timing, metadata, and status update.
   */
  private async executeTask(
    client: dbadapters.IDbClient,
    task: sqlanvil.IExecutionTask,
    parentAction: sqlanvil.IActionResult,
    options: { bigquery?: sqlanvil.IBigQueryOptions & IBigQueryExecutionOptions },
    action?: sqlanvil.IExecutionAction,
    statementOverride?: string,
    dryRunValidationQuery?: string,
  ): Promise<sqlanvil.TaskResult.ExecutionStatus> {
    const timer = Timer.start();
    const taskResult: sqlanvil.ITaskResult = {
      status: sqlanvil.TaskResult.ExecutionStatus.RUNNING,
      timing: timer.current(),
      metadata: {},
    };
    parentAction.tasks.push(taskResult);
    this.notifyListeners();
    if (statementOverride !== undefined) {
      taskResult.compiledSql = statementOverride;
    }
    if (options.bigquery?.dryRun && task.type === "assertion") {
      taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
    } else if (task.type === "export") {
      // Postgres/Supabase exports run runner-side via DuckDB (not on the warehouse client).
      try {
        const exporter = this.executionOptions.duckdbExport || runDuckdbExport;
        await exporter({
          spec: action?.export && {
            ...action.export,
            // Relative local destinations are project-relative (like script actions), not
            // cwd-relative.
            location: resolveLocalLocation(
              action.export.location,
              this.executionOptions.projectDir,
            ),
          },
          selectSql: task.statement,
          pg: this.executionOptions.warehouseConnection,
          storage: this.executionOptions.storageCredentials,
          actionName: action?.target?.name,
        });
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        taskResult.errorMessage = `${this.graph.projectConfig.warehouse} export error: ${e.message}`;
      }
    } else if (task.type === "import") {
      // Postgres/Supabase imports run runner-side via DuckDB (read the file, write into the
      // warehouse). BigQuery imports run on the warehouse client as a LOAD DATA statement.
      try {
        const importer = this.executionOptions.duckdbImport || runDuckdbImport;
        await importer({
          spec: action?.import && {
            ...action.import,
            // Relative local sources are project-relative — a script action stages
            // "staged/x.csv" with cwd = project dir; the import must read the same file no
            // matter where the CLI itself was invoked from.
            location: resolveLocalLocation(
              action.import.location,
              this.executionOptions.projectDir,
            ),
          },
          target: action?.target,
          pg: this.executionOptions.warehouseConnection,
          storage: this.executionOptions.storageCredentials,
        });
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        taskResult.errorMessage = `${this.graph.projectConfig.warehouse} import error: ${e.message}`;
      }
    } else if (task.type === "script") {
      // Script actions run runner-side: spawn the script's interpreter with cwd = the project
      // directory. No warehouse client involvement — and no warehouse credentials in the env.
      try {
        if (!this.executionOptions.projectDir) {
          throw new Error("script actions need the project directory (internal: projectDir unset)");
        }
        const scriptRunner = this.executionOptions.scriptRun || runScript;
        await scriptRunner({
          spec: action?.script,
          target: action?.target,
          projectDir: this.executionOptions.projectDir,
          vars: this.graph.projectConfig?.vars || {},
        });
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        taskResult.errorMessage = `script error: ${e.message}`;
      }
    } else if (task.type === "extract") {
      // runner-extract: read the cross-warehouse source (keyless BigQuery, MySQL/MariaDB) and
      // materialize the rows into this action's target (Postgres/Supabase), replacing the live
      // FDW foreign table.
      try {
        // Fail BEFORE touching (and billing) the source: a declaration without columnTypes
        // compiles (so migrations can introspect incrementally) but cannot extract.
        if (Object.keys(action?.extract?.columnTypes ?? {}).length === 0) {
          const ds =
            action?.extract?.platform === "mysql"
              ? action?.extract?.database
              : action?.extract?.dataset;
          throw new Error(
            `declaration "${action?.target?.name}" has no columnTypes — scaffold them with: ` +
              `sqlanvil introspect ${action?.extract?.connectionName} ${ds}.${action?.extract?.sourceName} ` +
              `--output <its .sqlx file>`,
          );
        }
        const extractor =
          action?.extract?.platform === "mysql"
            ? this.executionOptions.mysqlExtract || runMysqlExtract
            : this.executionOptions.bigQueryExtract || runBigQueryExtract;
        await this.acquireExtractSlot();
        try {
          await extractor({
            spec: action?.extract,
            target: action?.target,
            pg: this.executionOptions.warehouseConnection,
            connectionCredentials: this.executionOptions.connectionCredentials || {},
          });
        } finally {
          this.releaseExtractSlot();
        }
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        taskResult.errorMessage = `${this.graph.projectConfig.warehouse} extract error: ${e.message}`;
      }
    } else {
      let errorFromValidationQuery = false;
      try {
        // Retry this function a given number of times, configurable by user
        // Inject source-connection credentials into FDW-bridge statements at the last
        // moment (placeholders stay in the in-memory graph; secrets only reach the DB).
        const sqlToExecute = statementOverride ?? task.statement;
        const statement = this.executionOptions.connectionCredentials
          ? substituteConnectionCredentials(
              sqlToExecute,
              this.executionOptions.connectionCredentials,
            )
          : sqlToExecute;
        const { rows, metadata } = await retry(
          () =>
            client.execute(statement, {
              onCancel: (handleCancel) => this.eEmitter.on(CANCEL_EVENT, handleCancel),
              rowLimit: 1,
              bigquery: options.bigquery,
            }),
          task.type === "operation" ? 1 : options.bigquery.actionRetryLimit + 1 || 1,
        );
        if (dryRunValidationQuery) {
          errorFromValidationQuery = true;
          const validationResult = await retry(
            () =>
              client.execute(dryRunValidationQuery, {
                onCancel: (handleCancel) => this.eEmitter.on(CANCEL_EVENT, handleCancel),
                rowLimit: 1,
                bigquery: options.bigquery,
              }),
            options.bigquery.actionRetryLimit + 1 || 1,
          );
          taskResult.metadata = validationResult.metadata;
        } else {
          taskResult.metadata = metadata;
        }
        if (task.type === "assertion") {
          // We expect that an assertion query returns 1 row, with 1 field that is the row count.
          // We don't really care what that field/column is called.
          const rowCount = rows[0]?.[Object.keys(rows[0])[0]];
          if (rowCount > 0) {
            throw new Error(`Assertion failed: query returned ${rowCount} row(s).`);
          }
        }
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        // The validation query has the same lines as the task's statement, shifted by the lines
        // the wrapper adds, except for the `create or replace … as ` prefix before the start of
        // the query. Map positions in its error to the compiled SQL shown.
        const message = errorFromValidationQuery
          ? mapErrorPositions(
              e.message,
              dryRunValidationQuery,
              statementOverride ?? task.statement,
              CREATE_SCHEMA_WRAPPER_LINE_OFFSET,
            )
          : e.message;
        taskResult.errorMessage = `${this.graph.projectConfig?.warehouse} error: ${message}`;
        if (e.metadata?.bigquery?.jobId) {
          taskResult.metadata = {
            bigquery: {
              jobId: e.metadata.bigquery.jobId,
            },
          };
        }
      }
    }
    taskResult.timing = timer.end();
    this.notifyListeners();
    return taskResult.status;
  }
}
