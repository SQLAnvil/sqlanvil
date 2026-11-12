import * as fs from "fs";
import parseDuration from "parse-duration";

import { build, compile, credentials, run, test } from "sa/cli/api";
import { safeWriteArtifacts } from "sa/cli/api/commands/artifacts";
import { assertConnectionCredentialsAvailable } from "sa/cli/api/commands/connection_credentials";
import { IDbAdapter } from "sa/cli/api/dbadapters";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { prettyJsonStringify } from "sa/cli/api/utils";
import { runValidate } from "sa/cli/commands/validate_command";
import {
  actionsOption,
  artifactsOption,
  credentialsOption,
  credentialsPathWithEnvironment,
  includeDependentsOption,
  includeDepsOption,
  jsonOutputOption,
  projectConfigOverrideWithEnvironment,
  projectDirMustExistOption,
  projectDirOption,
  tagsOption,
  timeoutOption,
} from "sa/cli/common_options";
import {
  print,
  printCompiledGraphErrors,
  printError,
  printExecutedAction,
  printExecutionGraph,
  printSuccess,
  printTestResult,
  printWarning,
} from "sa/cli/console";
import { ProjectConfigArgv, ProjectConfigOptions } from "sa/cli/project_config_options";
import {
  actuallyResolve,
  assertPathExists,
  compiledGraphHasErrors,
  warnAboutSetDatasetIdWithoutLocation,
} from "sa/cli/util";
import { ICommand, option } from "sa/cli/yargswrapper";
import { targetAsReadableString } from "sa/core/targets";
import { version as sqlanvilVersion } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";

interface RunArgv extends ProjectConfigArgv {
  "project-dir": string;
  "dry-run"?: boolean;
  "build-only"?: boolean;
  "run-tests"?: boolean;
  "action-retry-limit": number;
  actions?: string[];
  artifacts: boolean;
  credentials: string;
  "full-refresh": boolean;
  graph?: string;
  "include-deps"?: boolean;
  "include-dependents"?: boolean;
  json: boolean;
  timeout: number | null;
  "execution-timeout": number | null;
  tags?: string[];
  "job-labels"?: { [key: string]: string };
  "job-prefix"?: string;
  // Read but not declared on `run` (undefined at runtime today).
  quiet?: boolean;
}

const fullRefreshOption = option("full-refresh", {
  describe: "Rebuild incremental tables from scratch.",
  type: "boolean",
  default: false,
});

const graphFileOption = option("graph", {
  describe:
    "Run a stored compiled graph (the output of compile --json) instead of compiling. What " +
    "runs is exactly what was compiled, including any environment overrides baked in at " +
    "compile time.",
  type: "string",
  coerce: (rawPath?: string) => (rawPath ? actuallyResolve(rawPath) : rawPath),
});

// Deliberately separate from --timeout, which is and stays compile-only (upstream #2247/#2256).
const executionTimeoutOption = option("execution-timeout", {
  describe:
    "Wall-clock deadline for the entire run (compilation plus every action), e.g. '15m'. When " +
    "it expires, in-flight actions are cancelled, pending ones are skipped and the run fails. " +
    "Off by default.",
  type: "string",
  default: null,
  coerce: (rawTimeoutString: string | null) =>
    rawTimeoutString ? parseDuration(rawTimeoutString) : null,
});

const jobPrefixOption = option("job-prefix", {
  describe:
    "BigQuery only. Prefix for BigQuery job IDs: --job-prefix nightly gives " +
    "sqlanvil-nightly-<uuid>.",
  type: "string",
  default: null,
});

const bigqueryJobLabelsOption = option("job-labels", {
  describe: "BigQuery only. Labels added to every BigQuery job, e.g. team=data,pipeline=nightly.",
  type: "string",
  coerce: (raw: string | null) => {
    const labels: { [key: string]: string } = {};
    raw?.split(",").forEach((kv) => {
      if (!kv) {
        return;
      }
      const [key, ...rest] = kv.split("=");
      labels[key] = rest.join("=") || "";
    });
    return labels;
  },
});

// Upstream #2418: what `run --dry-run --json` used to print (the execution graph), as its own flag.
const buildOnlyOption = option("build-only", {
  describe:
    "Only builds the execution graph (what would run, and each dataset's current state in the " +
    "warehouse) without running anything. With --json, prints the graph as JSON. --dry-run and " +
    "--run-tests are ignored when this is set.",
  type: "boolean",
  default: false,
});

const dryRunOptionName = "dry-run";
const runTestsOptionName = "run-tests";
const actionRetryLimitName = "action-retry-limit";

export const runCommand: ICommand = {
  format: `run [${projectDirMustExistOption.name}]`,
  description:
    "Compile the project and run it against the warehouse named by warehouse: in " +
    "workflow_settings.yaml.",
  positionalOptions: [projectDirMustExistOption],
  options: [
    option(dryRunOptionName, {
      describe:
        "Check the run without applying changes. On BigQuery this is BigQuery's server-side dry " +
        "run; on Postgres, Supabase and MySQL it runs validate, because those warehouses have " +
        "no native dry run.",
      type: "boolean",
    }),
    buildOnlyOption,
    option(runTestsOptionName, {
      describe: "Run the project's unit tests first, and abort the run if any fail.",
      type: "boolean",
    }),
    option(actionRetryLimitName, {
      describe: "Retry failed idempotent actions up to this many times.",
      type: "number",
      default: 0,
    }),
    actionsOption,
    credentialsOption,
    fullRefreshOption,
    graphFileOption,
    includeDepsOption,
    includeDependentsOption,
    jsonOutputOption,
    timeoutOption,
    executionTimeoutOption,
    tagsOption,
    jobPrefixOption,
    bigqueryJobLabelsOption,
    artifactsOption,
    ...ProjectConfigOptions.allYargsOptions,
  ],
  processFn: async (argv: RunArgv) => {
    const isJsonOutput = !!argv[jsonOutputOption.name];
    const buildOnly = !!argv[buildOnlyOption.name];
    if (buildOnly && argv[dryRunOptionName]) {
      printWarning(
        `Note: --${dryRunOptionName} is ignored because --${buildOnlyOption.name} is set`,
      );
    }
    if (buildOnly && argv[runTestsOptionName]) {
      printWarning(
        `Note: --${runTestsOptionName} is ignored because --${buildOnlyOption.name} is set`,
      );
    }
    const graphPath = argv[graphFileOption.name];
    let compiledGraph: sqlanvil.CompiledGraph;
    if (graphPath) {
      // Run a frozen, pre-compiled graph. Everything that shapes compilation is already
      // baked into it, so compile-time overrides make no sense here — reject rather than
      // silently ignore them.
      if (argv[ProjectConfigOptions.environment.name]) {
        printError(
          `--${graphFileOption.name} runs a frozen graph: its environment overrides were baked ` +
            `in at compile time. Compile with --environment instead, and pass --credentials ` +
            `explicitly for this run.`,
        );
        return 1;
      }
      assertPathExists(graphPath);
      try {
        compiledGraph = sqlanvil.CompiledGraph.fromObject(
          JSON.parse(fs.readFileSync(graphPath, "utf8")),
        );
      } catch (e) {
        printError(`Failed to load compiled graph from ${graphPath}: ${(e as Error).message}`);
        return 1;
      }
      const graphCore = compiledGraph.sqlanvilCoreVersion;
      const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");
      if (graphCore && majorMinor(graphCore) !== majorMinor(sqlanvilVersion)) {
        printWarning(
          `WARNING: graph was compiled by core ${graphCore}; this CLI is ${sqlanvilVersion}. ` +
            `Recompile the graph if the run misbehaves.\n`,
        );
      }
      if (!argv[jsonOutputOption.name]) {
        printSuccess(`Loaded compiled graph (core ${graphCore || "unknown"}) from ${graphPath}\n`);
      }
    } else {
      if (!argv[jsonOutputOption.name]) {
        print("Compiling...\n");
      }
      compiledGraph = await compile({
        projectDir: argv[projectDirOption.name],
        projectConfigOverride: projectConfigOverrideWithEnvironment(
          argv[projectDirOption.name],
          argv,
        ),
        timeoutMillis: argv[timeoutOption.name] || undefined,
      });
      if (!argv[jsonOutputOption.name] && !compiledGraphHasErrors(compiledGraph)) {
        printSuccess("Compiled successfully.\n");
      }
    }
    if (compiledGraphHasErrors(compiledGraph)) {
      printCompiledGraphErrors(compiledGraph.graphErrors);
      return 1;
    }
    const warehouse = compiledGraph.projectConfig.warehouse || "bigquery";

    // On Postgres/Supabase/MySQL there is no warehouse-native dry-run, and proceeding to
    // run() would APPLY changes — so `run --dry-run` there means "validate": EXPLAIN every
    // model in an isolated shadow namespace without executing. (BigQuery keeps its own
    // server-side dry-run below.) Delegated to the shared validate flow, which re-compiles
    // into the shadow namespace.
    if (argv[dryRunOptionName] && !buildOnly && warehouse.toLowerCase() !== "bigquery") {
      if (graphPath) {
        printError(
          `--${dryRunOptionName} on ${warehouse} validates by recompiling the project source, ` +
            `which --${graphFileOption.name} bypasses. Run \`sqlanvil validate\` on the project instead.`,
        );
        return 1;
      }
      return runValidate(argv);
    }

    const readCredentials = credentials.read(
      credentialsPathWithEnvironment(argv[projectDirOption.name], argv),
      warehouse,
    );
    const defaultLocation = compiledGraph.projectConfig?.defaultLocation;
    if (
      warehouse.toLowerCase() === "bigquery" &&
      defaultLocation &&
      readCredentials.location &&
      defaultLocation.toLowerCase() !== readCredentials.location.toLowerCase()
    ) {
      printWarning(
        `Warning: defaultLocation "${defaultLocation}" in the project config differs from ` +
          `location "${readCredentials.location}" in the credentials file. BigQuery jobs and ` +
          `new datasets will use "${defaultLocation}".\n`,
      );
    }

    let dbadapter: IDbAdapter;
    if (warehouse.toLowerCase() === "supabase") {
      dbadapter = await SupabaseDbAdapter.create(readCredentials);
    } else if (warehouse.toLowerCase() === "postgres") {
      dbadapter = await PostgresDbAdapter.create(readCredentials);
    } else if (warehouse.toLowerCase() === "mysql") {
      dbadapter = await MySqlDbAdapter.create(readCredentials);
    } else {
      dbadapter = new BigQueryDbAdapter(readCredentials);
    }
    const executionGraph = await build(
      compiledGraph,
      {
        fullRefresh: argv[fullRefreshOption.name],
        actions: argv[actionsOption.name],
        includeDependencies: argv[includeDepsOption.name],
        includeDependents: argv[includeDependentsOption.name],
        tags: argv[tagsOption.name],
        timeoutMillis: argv[executionTimeoutOption.name] || undefined,
      },
      dbadapter,
    );

    if (buildOnly) {
      printExecutionGraph(executionGraph, isJsonOutput);
      return 0;
    }

    if (argv[runTestsOptionName]) {
      if (!isJsonOutput) {
        print(`Running ${compiledGraph.tests.length} unit tests...\n`);
      }
      const testResults = await test(dbadapter, compiledGraph.tests);
      if (!isJsonOutput) {
        testResults.forEach((testResult) => printTestResult(testResult));
      } else {
        // Keep stdout a single JSON document: failures go to stderr.
        testResults
          .filter((testResult) => !testResult.successful)
          .forEach((testResult) => {
            printError(`${testResult.name}: failed`);
            testResult.messages?.forEach((message) => printError(message, 1));
          });
      }
      if (testResults.some((testResult) => !testResult.successful)) {
        printError("\nUnit tests did not pass; aborting run.");
        return 1;
      }
      if (!isJsonOutput) {
        printSuccess("Unit tests completed successfully.\n");
      }
    }

    let bigqueryOptions: {} = {
      actionRetryLimit: argv[actionRetryLimitName],
    };
    if (argv[dryRunOptionName]) {
      bigqueryOptions = { ...bigqueryOptions, dryRun: argv[dryRunOptionName] };
    }
    if (argv[jobPrefixOption.name]) {
      bigqueryOptions = { ...bigqueryOptions, jobPrefix: argv[jobPrefixOption.name] };
    }
    if (argv[bigqueryJobLabelsOption.name]) {
      bigqueryOptions = { ...bigqueryOptions, labels: argv[bigqueryJobLabelsOption.name] };
    }

    const actionsByName = new Map<string, sqlanvil.IExecutionAction>();
    executionGraph.actions.forEach((action) => {
      actionsByName.set(targetAsReadableString(action.target), action);
    });

    if (actionsByName.size === 0) {
      if (isJsonOutput) {
        print(
          prettyJsonStringify({
            status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
            actions: [],
          }),
        );
      } else {
        print("No actions to run.\n");
      }
      return 0;
    }

    // Source-connection creds for FDW-bridge user mappings. Read here (not in the
    // --build-only path above) and validated fail-fast before anything executes.
    const connectionCredentials = credentials.readConnections(
      credentialsPathWithEnvironment(argv[projectDirOption.name], argv),
    );
    assertConnectionCredentialsAvailable(executionGraph, connectionCredentials);

    // For runner-side DuckDB exports (Postgres/Supabase): the source DB connection to
    // ATTACH, plus object-store credentials. Ignored on BigQuery (exports run in-engine).
    const storageCredentials = credentials.readStorageCredentials(
      credentialsPathWithEnvironment(argv[projectDirOption.name], argv),
    );
    const isPostgresLike =
      warehouse.toLowerCase() === "postgres" || warehouse.toLowerCase() === "supabase";

    if (isJsonOutput) {
      // No progress lines: stdout carries only the final RunResult.
    } else if (argv[dryRunOptionName]) {
      print("Dry running (no changes to the warehouse will be applied)...");
    } else {
      print("Running...\n");
    }

    const runner = run(dbadapter, executionGraph, {
      bigquery: bigqueryOptions,
      connectionCredentials,
      warehouseConnection: isPostgresLike ? readCredentials : undefined,
      storageCredentials,
      // For script actions: the cwd the script runs in (projectDirOption is coerced to
      // an absolute path).
      projectDir: argv[projectDirOption.name],
    });
    process.on("SIGINT", () => {
      runner.cancel();
    });

    const alreadyPrintedActions = new Set<string>();

    const printExecutedGraph = (executedGraph: sqlanvil.IRunResult) => {
      executedGraph.actions
        .filter(
          (actionResult) => actionResult.status !== sqlanvil.ActionResult.ExecutionStatus.RUNNING,
        )
        .filter(
          (executedAction) =>
            !alreadyPrintedActions.has(targetAsReadableString(executedAction.target)),
        )
        .forEach((executedAction) => {
          printExecutedAction(
            executedAction,
            actionsByName.get(targetAsReadableString(executedAction.target)),
            argv[dryRunOptionName],
          );
          alreadyPrintedActions.add(targetAsReadableString(executedAction.target));
        });
    };

    if (!isJsonOutput) {
      runner.onChange(printExecutedGraph);
    }
    const runResult = await runner.result();
    if (isJsonOutput) {
      print(prettyJsonStringify(runResult));
    } else {
      printExecutedGraph(runResult);
    }
    if (warehouse.toLowerCase() === "bigquery") {
      warnAboutSetDatasetIdWithoutLocation(
        executionGraph.actions,
        defaultLocation || readCredentials.location || undefined,
      );
    }
    // stderr, so these show with --json too.
    if (runResult.status === sqlanvil.RunResult.ExecutionStatus.TIMED_OUT) {
      const executionTimeoutMillis = argv[executionTimeoutOption.name];
      const suffix = executionTimeoutMillis
        ? ` after ${executionTimeoutMillis / 1000} seconds (--execution-timeout)`
        : "";
      printError(`Run timed out${suffix}.`);
    } else if (runResult.status === sqlanvil.RunResult.ExecutionStatus.CANCELLED) {
      printError("Run cancelled.");
    }
    if (argv[artifactsOption.name] !== false) {
      await safeWriteArtifacts(compiledGraph, argv[projectDirOption.name], {
        runResult,
        runId: Date.now(),
        warn: isJsonOutput ? (message: string) => printWarning(message) : print,
      });
    }
    return runResult.status === sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL ? 0 : 1;
  },
};
