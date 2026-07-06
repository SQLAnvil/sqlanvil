import EventEmitter from "events";
import Long from "long";

import * as dbadapters from "sa/cli/api/dbadapters";
import { substituteConnectionCredentials } from "sa/cli/api/commands/connection_credentials";
import { IBigQueryExecutionOptions } from "sa/cli/api/dbadapters/bigquery";
import { BigQueryExtractArgs, runBigQueryExtract } from "sa/cli/api/dbadapters/bigquery_extract";
import { MysqlExtractArgs, runMysqlExtract } from "sa/cli/api/dbadapters/mysql_extract";
import { DuckdbExportArgs, runDuckdbExport } from "sa/cli/api/dbadapters/duckdb_export";
import { DuckdbImportArgs, runDuckdbImport } from "sa/cli/api/dbadapters/duckdb_import";
import { runScript, ScriptRunArgs } from "sa/cli/api/commands/script_run";
import { Flags } from "sa/common/flags";
import { retry } from "sa/common/promises";
import { deepClone, equals } from "sa/common/protos";
import { targetStringifier } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";

const CANCEL_EVENT = "jobCancel";
const flags = {
  runnerNotificationPeriodMillis: Flags.number("runner-notification-period-millis", 5000)
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
}

export function run(
  dbadapter: dbadapters.IDbAdapter,
  graph: sqlanvil.IExecutionGraph,
  executionOptions?: IExecutionOptions,
  partiallyExecutedRunResult: sqlanvil.IRunResult = {},
  runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get()
): Runner {
  return new Runner(
    dbadapter,
    graph,
    executionOptions,
    partiallyExecutedRunResult,
    runnerNotificationPeriodMillis
  ).execute();
}

export class Runner {
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

  constructor(
    private readonly dbadapter: dbadapters.IDbAdapter,
    private readonly graph: sqlanvil.IExecutionGraph,
    private readonly executionOptions: IExecutionOptions = {},
    partiallyExecutedRunResult: sqlanvil.IRunResult = {},
    private readonly runnerNotificationPeriodMillis: number = flags.runnerNotificationPeriodMillis.get()
  ) {
    this.allActionTargets = new Set<string>(
      graph.actions.map(action => targetStringifier.stringify(action.target))
    );
    this.runResult = {
      actions: [],
      ...partiallyExecutedRunResult
    };
    this.warehouseStateByTarget = new Map<string, sqlanvil.ITableMetadata>();
    graph.warehouseState.tables?.forEach(tableMetadata =>
      this.warehouseStateByTarget.set(
        targetStringifier.stringify(tableMetadata.target),
        tableMetadata
      )
    );
    this.executedActionTargets = new Set(
      this.runResult.actions
        .filter(action => action.status !== sqlanvil.ActionResult.ExecutionStatus.RUNNING)
        .map(action => targetStringifier.stringify(action.target))
    );
    this.successfullyExecutedActionTargets = new Set<string>(
      this.runResult.actions
        .filter(isSuccessfulAction)
        .map(action => targetStringifier.stringify(action.target))
    );
    this.pendingActions = graph.actions.filter(
      action => !this.executedActionTargets.has(targetStringifier.stringify(action.target))
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
    if (!!this.executionTask) {
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
        this.cancel();
      }, timeoutMillis);
    }
    return this;
  }

  public stop() {
    this.stopped = true;
  }

  public cancel() {
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
    this.changeListeners.forEach(listener => listener(runResultClone));
  }

  private async executeGraph() {
    const timer = Timer.start(this.runResult.timing);

    this.runResult.status = sqlanvil.RunResult.ExecutionStatus.RUNNING;
    this.runResult.timing = timer.current();
    this.notifyListeners();

    // If we're not resuming an existing run, prepare schemas.
    if (this.runResult.actions.length === 0) {
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
        action => action.status === sqlanvil.ActionResult.ExecutionStatus.FAILED
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
      .filter(action => !!action.target && !!action.target.schema)
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
            .filter(schema => !existingSchemas.has(schema))
            .map(schema => this.dbadapter.createSchema(database, schema))
        );
      })
    );
  }

  private async executeAllActionsReadyForExecution() {
    if (this.stopped) {
      return;
    }

    // If the run has been cancelled, cancel all pending actions.
    if (this.cancelled) {
      const allPendingActions = this.pendingActions;
      this.pendingActions = [];
      allPendingActions.forEach(pendingAction =>
        this.runResult.actions.push({
          target: pendingAction.target,
          status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
          tasks: pendingAction.tasks.map(() => ({
            status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED
          }))
        })
      );
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
          dependency =>
            !this.allActionTargets.has(targetStringifier.stringify(dependency)) ||
            this.successfullyExecutedActionTargets.has(targetStringifier.stringify(dependency))
        )
      ) {
        executableActions.push(pendingAction);
      } else if (
        // An action is skippable if it is not executable and all dependencies either: do not
        // exist in the graph, or have completed execution.
        pendingAction.dependencyTargets.every(
          dependency =>
            !this.allActionTargets.has(targetStringifier.stringify(dependency)) ||
            this.executedActionTargets.has(targetStringifier.stringify(dependency))
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
        skippableActions.forEach(skippableAction => {
          this.runResult.actions.push({
            target: skippableAction.target,
            status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
            tasks: skippableAction.tasks.map(() => ({
              status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED
            }))
          });
        });
        if (skippableActions.length > 0) {
          this.notifyListeners();
          await this.executeAllActionsReadyForExecution();
        }
      })(),
      Promise.all(
        executableActions.map(async executableAction => {
          const actionResult = await this.executeAction(executableAction);
          this.executedActionTargets.add(targetStringifier.stringify(executableAction.target));
          if (isSuccessfulAction(actionResult)) {
            this.successfullyExecutedActionTargets.add(
              targetStringifier.stringify(executableAction.target)
            );
          }
          await this.executeAllActionsReadyForExecution();
        })
      )
    ]);
  }

  private async executeAction(action: sqlanvil.IExecutionAction): Promise<sqlanvil.IActionResult> {
    let actionResult: sqlanvil.IActionResult = {
      target: action.target,
      tasks: []
    };

    if (action.tasks.length === 0) {
      actionResult.status = sqlanvil.ActionResult.ExecutionStatus.DISABLED;
      this.runResult.actions.push(actionResult);
      this.notifyListeners();
      return actionResult;
    }

    const resumedActionResult = this.runResult.actions.find(existingActionResult =>
      equals(sqlanvil.Target, existingActionResult.target, action.target)
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

    await this.dbadapter.withClientLock(async client => {
      // Start running tasks from the last executed task (if any), onwards.
      for (const task of action.tasks.slice(actionResult.tasks.length)) {
        if (this.stopped) {
          return actionResult;
        }
        if (
          actionResult.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING &&
          !this.cancelled
        ) {
          const taskStatus = await this.executeTask(client, task, actionResult, {
            bigquery: {
              // Merge global run-level labels with action-level labels. Action-level labels take precedence.
              labels: {
                ...(this.executionOptions?.bigquery?.labels || {}),
                ...(action.actionDescriptor?.bigqueryLabels || {})
              },
              actionRetryLimit: this.executionOptions?.bigquery?.actionRetryLimit,
              jobPrefix: this.executionOptions?.bigquery?.jobPrefix,
              dryRun: this.executionOptions?.bigquery?.dryRun,
              reservation:
                action.actionDescriptor?.reservation ||
                this.graph.projectConfig?.defaultReservation
            }
          }, action);
          if (taskStatus === sqlanvil.TaskResult.ExecutionStatus.FAILED) {
            actionResult.status = sqlanvil.ActionResult.ExecutionStatus.FAILED;
          } else if (taskStatus === sqlanvil.TaskResult.ExecutionStatus.CANCELLED) {
            actionResult.status = sqlanvil.ActionResult.ExecutionStatus.CANCELLED;
          }
        } else {
          actionResult.tasks.push({
            status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED
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
          actionResult.tasks[
            actionResult.tasks.length - 1
          ].errorMessage = `Error setting metadata: ${e.message}`;
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

  private async executeTask(
    client: dbadapters.IDbClient,
    task: sqlanvil.IExecutionTask,
    parentAction: sqlanvil.IActionResult,
    options: { bigquery?: sqlanvil.IBigQueryOptions & IBigQueryExecutionOptions },
    action?: sqlanvil.IExecutionAction
  ): Promise<sqlanvil.TaskResult.ExecutionStatus> {
    const timer = Timer.start();
    const taskResult: sqlanvil.ITaskResult = {
      status: sqlanvil.TaskResult.ExecutionStatus.RUNNING,
      timing: timer.current(),
      metadata: {}
    };
    parentAction.tasks.push(taskResult);
    this.notifyListeners();
    if (options.bigquery?.dryRun && task.type === "assertion") {
      taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
    } else if (task.type === "export") {
      // Postgres/Supabase exports run runner-side via DuckDB (not on the warehouse client).
      try {
        const exporter = this.executionOptions.duckdbExport || runDuckdbExport;
        await exporter({
          spec: action?.export,
          selectSql: task.statement,
          pg: this.executionOptions.warehouseConnection,
          storage: this.executionOptions.storageCredentials,
          actionName: action?.target?.name
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
          spec: action?.import,
          target: action?.target,
          pg: this.executionOptions.warehouseConnection,
          storage: this.executionOptions.storageCredentials
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
          vars: this.graph.projectConfig?.vars || {}
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
        const extractor =
          action?.extract?.platform === "mysql"
            ? this.executionOptions.mysqlExtract || runMysqlExtract
            : this.executionOptions.bigQueryExtract || runBigQueryExtract;
        await extractor({
          spec: action?.extract,
          target: action?.target,
          pg: this.executionOptions.warehouseConnection,
          connectionCredentials: this.executionOptions.connectionCredentials || {}
        });
        taskResult.status = sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL;
      } catch (e) {
        taskResult.status = this.cancelled
          ? sqlanvil.TaskResult.ExecutionStatus.CANCELLED
          : sqlanvil.TaskResult.ExecutionStatus.FAILED;
        taskResult.errorMessage = `${this.graph.projectConfig.warehouse} extract error: ${e.message}`;
      }
    } else {
      try {
        // Retry this function a given number of times, configurable by user
        // Inject source-connection credentials into FDW-bridge statements at the last
        // moment (placeholders stay in the in-memory graph; secrets only reach the DB).
        const statement = this.executionOptions.connectionCredentials
          ? substituteConnectionCredentials(task.statement, this.executionOptions.connectionCredentials)
          : task.statement;
        const { rows, metadata } = await retry(
          () =>
            client.execute(statement, {
              onCancel: handleCancel => this.eEmitter.on(CANCEL_EVENT, handleCancel),
              rowLimit: 1,
              bigquery: options.bigquery
            }),
          task.type === "operation" ? 1 : options.bigquery.actionRetryLimit + 1 || 1
        );
        taskResult.metadata = metadata;
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
        taskResult.errorMessage = `${this.graph.projectConfig.warehouse} error: ${e.message}`;
        if (e.metadata?.bigquery?.jobId) {
          taskResult.metadata = {
            bigquery: {
              jobId: e.metadata.bigquery.jobId
            }
          };
        }
      }
    }
    taskResult.timing = timer.end();
    this.notifyListeners();
    return taskResult.status;
  }
}

class Timer {
  public static start(existingTiming?: sqlanvil.ITiming) {
    return new Timer(existingTiming?.startTimeMillis.toNumber() || new Date().valueOf());
  }
  private constructor(readonly startTimeMillis: number) { }

  public current(): sqlanvil.ITiming {
    return {
      startTimeMillis: Long.fromNumber(this.startTimeMillis)
    };
  }

  public end(): sqlanvil.ITiming {
    return {
      startTimeMillis: Long.fromNumber(this.startTimeMillis),
      endTimeMillis: Long.fromNumber(new Date().valueOf())
    };
  }
}
