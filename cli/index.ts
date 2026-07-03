import * as chokidar from "chokidar";
import * as fs from "fs";
import * as glob from "glob";
import parseDuration from "parse-duration";
import * as path from "path";
import yargs from "yargs";

import { build, compile, credentials, init, install, introspectToSqlx, prune, run, test } from "sa/cli/api";
import { CREDENTIALS_FILENAME } from "sa/cli/api/commands/credentials";
import {
  mergeProjectConfigOverride,
  resolveCredentials,
  resolveEnvironment
} from "sa/cli/api/commands/environments";
import { assertConnectionCredentialsAvailable } from "sa/cli/api/commands/connection_credentials";
import { safeWriteArtifacts, TARGET_DIR } from "sa/cli/api/commands/artifacts";
import { buildDocsModel, renderDocsHtml } from "sa/cli/api/commands/docs";
import { ArtifactView, queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { sweepOrphanShadows, validate, ValidateDeps } from "sa/cli/api/commands/validate";
import { ValidationResult, validateShadowSuffix } from "sa/cli/api/commands/validate_graph";
import { IDbAdapter } from "sa/cli/api/dbadapters";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  compiledGraphOutputType,
  print,
  printCompiledGraph,
  printCompiledGraphErrors,
  printError,
  printExecutedAction,
  printExecutionGraph,
  printFormatFilesResult,
  printInitCredsResult,
  printInitResult,
  printSuccess,
  printTestResult
} from "sa/cli/console";
import { getBigQueryCredentials } from "sa/cli/credentials";
import {
  actuallyResolve,
  assertPathExists,
  compiledGraphHasErrors,
  promptForIcebergConfig,
} from "sa/cli/util";
import { createYargsCli, option, positionalOption } from "sa/cli/yargswrapper";
import { targetAsReadableString } from "sa/core/targets";
import { dataformVersion, version as sqlanvilVersion } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";
import { formatFile } from "sa/sqlx/format";

const RECOMPILE_DELAY = 500;

process.on("unhandledRejection", async (reason: unknown) => {
  printError(`Unhandled promise rejection: ${(reason as Error)?.stack || reason}`);
});

// Per-command argv interfaces. yargs gained a well-typed API in v12; rather than
// rewrite the data-driven command builder onto the fluent chain, each command's
// handler is annotated with the interface describing exactly the args it reads.
// The `option`/`positionalOption` factories (yargswrapper) capture each flag name
// as a string literal, so `argv[someOption.name]` indexes these interfaces by the
// exact key. Types reflect post-`coerce` values (e.g. timeout: number, project-dir:
// string). Optional members marked `?` are either non-defaulted flags or — noted
// inline — flags a handler reads without declaring (undefined at runtime today).

/** The shared `ProjectConfigOptions.allYargsOptions`, all optional overrides. */
interface ProjectConfigArgv {
  "default-database"?: string;
  "default-schema"?: string;
  "default-location"?: string;
  "assertion-schema"?: string;
  vars?: { [key: string]: string };
  "database-suffix"?: string;
  "schema-suffix"?: string;
  "table-prefix"?: string;
  "disable-assertions"?: boolean;
  "default-reservation"?: string;
  environment?: string;
}

interface InitArgv {
  "project-dir": string;
  "default-database"?: string;
  "default-location"?: string;
  warehouse: string;
  iceberg: boolean;
}

interface InstallArgv {
  "project-dir": string;
}

interface InitCredsArgv {
  "project-dir": string;
  "test-connection": boolean;
}

interface CompileArgv extends ProjectConfigArgv {
  "project-dir": string;
  watch: boolean;
  json: boolean;
  dot: boolean;
  timeout: number | null;
  quiet: boolean;
  verbose: boolean;
  actions?: string[];
  tags?: string[];
  "include-deps"?: boolean;
  "include-dependents"?: boolean;
}

interface TestArgv extends ProjectConfigArgv {
  "project-dir": string;
  credentials: string;
  timeout: number | null;
  json: boolean;
  // Read via printCompiledGraphErrors but not declared on `test` (undefined at runtime).
  quiet?: boolean;
}

interface RunArgv extends ProjectConfigArgv {
  "project-dir": string;
  "dry-run"?: boolean;
  "run-tests"?: boolean;
  "action-retry-limit": number;
  actions?: string[];
  credentials: string;
  "full-refresh": boolean;
  graph?: string;
  "include-deps"?: boolean;
  "include-dependents"?: boolean;
  json: boolean;
  timeout: number | null;
  tags?: string[];
  "job-labels"?: { [key: string]: string };
  // Read but not declared on `run` (undefined at runtime today).
  quiet?: boolean;
  "job-prefix"?: string;
}

interface FormatArgv {
  "project-dir": string;
  actions?: string[];
  check: boolean;
}

interface IntrospectArgv {
  connection: string;
  tableRef: string;
  "project-dir": string;
  output?: string;
}

const projectDirOption = positionalOption("project-dir", {
  describe: "The sqlanvil project directory.",
  default: ".",
  coerce: actuallyResolve
});

const projectDirMustExistOption = {
  ...projectDirOption,
  check: (argv: { "project-dir": string; graph?: string }) => {
    assertPathExists(argv[projectDirOption.name]);
    // With --graph the compiled graph IS the project — the directory is only a working dir
    // (credentials, artifacts), so don't require workflow_settings.yaml there.
    if (argv.graph) {
      return;
    }
    const workflowSettingsYamlPath = path.resolve(
      argv[projectDirOption.name],
      "workflow_settings.yaml"
    );
    if (!fs.existsSync(workflowSettingsYamlPath)) {
      throw new Error(
        `${
          argv[projectDirOption.name]
        } does not appear to be a sqlanvil directory (missing workflow_settings.yaml file).`
      );
    }
  }
};

const fullRefreshOption = option("full-refresh", {
  describe: "Forces incremental tables to be rebuilt from scratch.",
  type: "boolean",
  default: false
});

const graphFileOption = option("graph", {
  describe:
    "Path to a stored compiled graph (the JSON emitted by `compile --json`). Runs it directly, " +
    "without compiling the project — what executes is exactly what was compiled, including any " +
    "environment overrides baked in at compile time.",
  type: "string",
  coerce: (rawPath?: string) => (rawPath ? actuallyResolve(rawPath) : rawPath)
});

const actionsOption = option("actions", {
  describe: "A list of action names or patterns to run. Can include '*' wildcards.",
  type: "array",
  coerce: (rawActions: string[] | null) => rawActions.map(actions => actions.split(",")).flat()
});

const tagsOption = option("tags", {
  describe: "A list of tags to filter the actions to run.",
  type: "array",
  coerce: (rawTags: string[] | null) => rawTags.map(tags => tags.split(",")).flat()
});

const includeDepsOption = option(
  "include-deps",
  {
    describe: "If set, dependencies for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  (argv: Pick<RunArgv, "include-deps" | "actions" | "tags">) => {
    if (argv[includeDepsOption.name] && !(argv[actionsOption.name] || argv[tagsOption.name])) {
      throw new Error(
        `The --${includeDepsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
);

const includeDependentsOption = option(
  "include-dependents",
  {
    describe: "If set, dependents (downstream) for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  (argv: Pick<RunArgv, "include-dependents" | "actions" | "tags">) => {
    if (
      argv[includeDependentsOption.name] &&
      !(argv[actionsOption.name] || argv[tagsOption.name])
    ) {
      throw new Error(
        `The --${includeDependentsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
);

// `compile` reuses the same selection flags as `run`, but it filters the printed
// graph rather than executing actions -- so it gets output-focused help text.
// Same flag names (so argv indexing and the shared validation still apply); only
// the describe strings differ.
const compileActionsOption = {
  ...actionsOption,
  option: {
    ...actionsOption.option,
    describe: "A list of action names or patterns to include in the output. Can include '*' wildcards."
  }
};

const compileTagsOption = {
  ...tagsOption,
  option: { ...tagsOption.option, describe: "A list of tags to filter the output to." }
};

const compileIncludeDepsOption = {
  ...includeDepsOption,
  option: {
    ...includeDepsOption.option,
    describe: "If set, dependencies of selected actions are also included in the output."
  }
};

const compileIncludeDependentsOption = {
  ...includeDependentsOption,
  option: {
    ...includeDependentsOption.option,
    describe: "If set, dependents (downstream) of selected actions are also included in the output."
  }
};

const credentialsOption = option(
  "credentials",
  {
    describe: "The location of the credentials JSON file to use.",
    default: CREDENTIALS_FILENAME
  },
  (argv: { "project-dir": string; credentials: string }) => {
    getCredentialsPath(argv[projectDirOption.name], argv.credentials);
  }
);

const jsonOutputOption = option("json", {
  describe: "Outputs a JSON representation of the compiled project or test results.",
  type: "boolean",
  default: false
});

const dotOutputOption = option(
  "dot",
  {
    describe: "Outputs a dot representation of the compiled project.",
    type: "boolean",
    default: false
  },
  (argv: { json?: boolean; dot?: boolean }) => {
    if (argv.json && argv.dot) {
      throw new Error("Arguments --json and --dot are mutually exclusive.");
    }
  }
);

const timeoutOption = option("timeout", {
  describe: "Duration to allow project compilation to complete. Examples: '1s', '10m', etc.",
  type: "string",
  default: null,
  coerce: (rawTimeoutString: string | null) =>
    rawTimeoutString ? parseDuration(rawTimeoutString) : null
});

const noArtifactsOption = option("no-artifacts", {
  describe:
    "Skip writing the queryable Parquet artifacts under target/ (catalog on compile; run history " +
    "on run).",
  type: "boolean"
});

const keepShadowOption = option("keep-shadow", {
  describe:
    "If set, `validate` leaves its temporary shadow schema(s) in place instead of dropping them " +
    "(debugging aid).",
  type: "boolean"
});

const jobPrefixOption = option("job-prefix", {
  describe: "Adds an additional prefix in the form of `sqlanvil-${jobPrefix}-`.",
  type: "string",
  default: null
});

const bigqueryJobLabelsOption = option("job-labels", {
  describe: "Comma-separated list of labels to add to BigQuery jobs, e.g. 'key1=val1,key2=val2'.",
  type: "string",
  coerce: (raw: string | null) => {
    const labels: { [key: string]: string } = {};
    raw?.split(",").forEach(kv => {
      if (!kv) {
        return;
      }
      const [key, ...rest] = kv.split("=");
      labels[key] = rest.join("=") || "";
    });
    return labels;
  }
});

const quietCompileOption = option("quiet", {
  describe: "Less verbose compilation output. Example usage: 'sqlanvil compile --quiet'",
  type: "boolean",
  default: false
});

const icebergOption = option("iceberg", {
  describe: "Initialize the project with workflow-level Iceberg tables configuration.",
  type: "boolean",
  default: false
});

const warehouseOption = option("warehouse", {
  describe: "Target warehouse for the new project.",
  type: "string",
  choices: ["bigquery", "postgres", "supabase", "mysql"],
  default: "supabase"
});

const testConnectionOptionName = "test-connection";

const watchOptionName = "watch";

const verboseOptionName = "verbose";
const dryRunOptionName = "dry-run";
const runTestsOptionName = "run-tests";
const checkOptionName = "check";

const actionRetryLimitName = "action-retry-limit";

function getCredentialsPath(projectDir: string, credentialsPath: string) {
  return actuallyResolve(projectDir, credentialsPath);
}

// projectConfigOverride that layers the named environment (if any) under the CLI
// flags. Used by compile/run/test.
function projectConfigOverrideWithEnvironment(
  projectDir: string,
  argv: ProjectConfigArgv
): sqlanvil.IProjectConfig {
  const cliOverride = ProjectConfigOptions.constructProjectConfigOverride(argv);
  if (!argv[ProjectConfigOptions.environment.name]) {
    return cliOverride;
  }
  const { configOverride } = resolveEnvironment(
    projectDir,
    argv[ProjectConfigOptions.environment.name]
  );
  return mergeProjectConfigOverride(configOverride, cliOverride);
}

// Resolved absolute credentials path, applying --credentials > env > default. Used
// by run/test.
function credentialsPathWithEnvironment(projectDir: string, argv: any): string {
  const envCredentials = argv[ProjectConfigOptions.environment.name]
    ? resolveEnvironment(projectDir, argv[ProjectConfigOptions.environment.name]).credentials
    : undefined;
  const chosen = resolveCredentials(
    envCredentials,
    argv[credentialsOption.name],
    CREDENTIALS_FILENAME
  );
  return getCredentialsPath(projectDir, chosen);
}

// Print `validate` results; returns the process exit code (1 if any FAILURE/BLOCKED).
function printValidationResults(results: ValidationResult[], json: boolean): number {
  const failures = results.filter(r => r.status === "FAILURE");
  const blocked = results.filter(r => r.status === "BLOCKED");
  const passed = results.filter(r => r.status === "PASS");
  const skipped = results.filter(r => r.status === "SKIPPED");

  if (json) {
    print(prettyJsonStringify(results));
  } else {
    for (const result of results) {
      const label = targetAsReadableString(result.target);
      if (result.status === "PASS") {
        printSuccess(`  PASS   ${label}`);
      } else if (result.status === "SKIPPED") {
        print(`  SKIP   ${label} (${result.type} — not validated)`);
      } else if (result.status === "BLOCKED") {
        printError(`  BLOCK  ${label} — blocked by an upstream failure`);
      } else {
        printError(`  FAIL   ${label}`);
        result.errors
          .filter(e => e.status === sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE)
          .forEach(e => {
            const loc = e.error?.errorLocation
              ? ` (line ${e.error.errorLocation.line}, col ${e.error.errorLocation.column})`
              : "";
            printError(`           ${(e.error && e.error.message) || "validation failed"}${loc}`);
          });
      }
    }
    print(
      `\n${passed.length} passed, ${failures.length} failed, ${blocked.length} blocked` +
        (skipped.length ? `, ${skipped.length} skipped` : "")
    );
  }
  return failures.length > 0 || blocked.length > 0 ? 1 : 0;
}

// Shared `validate` flow, used by the `validate` command and by `run --dry-run` on
// Postgres/Supabase/MySQL. Compiles into an isolated, timestamped shadow namespace (so the
// WITH NO DATA / LIMIT 0 stubs and the DROP SCHEMA CASCADE teardown never touch real targets),
// then validates every model against the warehouse planner. Returns the process exit code.
async function runValidate(argv: any): Promise<number> {
  const projectDir = argv[projectDirOption.name];
  if (!argv[jsonOutputOption.name]) {
    print("Compiling...\n");
  }
  const baseOverride = projectConfigOverrideWithEnvironment(projectDir, argv);
  const shadowSuffix = validateShadowSuffix(Date.now());
  const compiledGraph = await compile({
    projectDir,
    projectConfigOverride: {
      ...baseOverride,
      schemaSuffix: [baseOverride.schemaSuffix, shadowSuffix].filter(Boolean).join("_")
    },
    timeoutMillis: argv[timeoutOption.name] || undefined
  });
  if (compiledGraphHasErrors(compiledGraph)) {
    printCompiledGraphErrors(compiledGraph.graphErrors, argv[quietCompileOption.name]);
    return 1;
  }
  if (!argv[jsonOutputOption.name]) {
    printSuccess("Compiled successfully.\n");
  }

  const warehouse = (compiledGraph.projectConfig.warehouse || "bigquery").toLowerCase();
  const readCredentials = credentials.read(
    credentialsPathWithEnvironment(projectDir, argv),
    warehouse
  );
  let dbadapter: IDbAdapter;
  if (warehouse === "supabase") {
    dbadapter = await SupabaseDbAdapter.create(readCredentials);
  } else if (warehouse === "mysql") {
    dbadapter = await MySqlDbAdapter.create(readCredentials);
  } else if (warehouse === "bigquery") {
    dbadapter = new BigQueryDbAdapter(readCredentials);
  } else {
    dbadapter = await PostgresDbAdapter.create(readCredentials);
  }

  const prunedGraph = prune(compiledGraph, {
    actions: argv[actionsOption.name],
    includeDependencies: argv[includeDepsOption.name],
    includeDependents: argv[includeDependentsOption.name],
    tags: argv[tagsOption.name]
  });
  const executionSql = new ExecutionSql(compiledGraph.projectConfig, dataformVersion);

  // Best-effort teardown if the user Ctrl-C's mid-validation (the orchestrator's own finally
  // covers normal completion + errors; the orphan sweep covers hard kills).
  const shadowSchemas = Array.from(
    new Set((prunedGraph.tables || []).map(table => table.target.schema))
  );
  process.on("SIGINT", () => {
    Promise.all(
      shadowSchemas.map(schema =>
        dbadapter.execute(executionSql.dropSchemaCascadeSql(schema)).catch(() => undefined)
      )
    ).then(() => process.exit(1));
  });

  const deps: ValidateDeps = {
    evaluate: action =>
      dbadapter.evaluate(
        (action as sqlanvil.ITable).enumType !== undefined
          ? sqlanvil.Table.create(action as sqlanvil.ITable)
          : sqlanvil.Assertion.create(action as sqlanvil.IAssertion)
      ),
    execute: sql => dbadapter.execute(sql).then(() => undefined),
    validationStubSql: table => executionSql.validationStubSql(table),
    createSchemaSql: schema => executionSql.createSchemaSql(schema),
    dropSchemaCascadeSql: schema => executionSql.dropSchemaCascadeSql(schema),
    listSchemas: async () => {
      const result = await dbadapter.execute(
        "select schema_name as name from information_schema.schemata"
      );
      return ((result && result.rows) || []).map((row: any) => row.name);
    }
  };

  // Best-effort: clear shadow schemas orphaned by previously-killed validate runs.
  await sweepOrphanShadows(deps, Date.now());

  if (!argv[jsonOutputOption.name]) {
    print("Validating...\n");
  }
  const results = await validate(prunedGraph, deps, { keepShadow: argv[keepShadowOption.name] });
  return printValidationResults(results, argv[jsonOutputOption.name]);
}

// --- Queryable artifacts (`query` / `inspect`) over target/*.parquet via bundled DuckDB. ---

function resolveArtifactViews(
  projectDir: string
): { views: ArtifactView[]; hasCatalog: boolean; hasRuns: boolean } {
  const catalogDir = path.join(projectDir, TARGET_DIR, "catalog");
  const runsDir = path.join(projectDir, TARGET_DIR, "runs");
  const views: ArtifactView[] = [];
  for (const name of ["actions", "dependencies", "columns"]) {
    const file = path.join(catalogDir, `${name}.parquet`);
    if (fs.existsSync(file)) {
      views.push({ name, glob: file });
    }
  }
  const hasRuns =
    fs.existsSync(runsDir) && fs.readdirSync(runsDir).some(f => f.endsWith(".parquet"));
  if (hasRuns) {
    views.push({ name: "runs", glob: path.join(runsDir, "*.parquet") });
  }
  return { views, hasCatalog: views.some(v => v.name === "actions"), hasRuns };
}

function printArtifactRows(rows: any[]): void {
  if (!rows || rows.length === 0) {
    print("(0 rows)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] === null || r[c] === undefined ? "" : r[c]).length))
  );
  const fmtRow = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  print(fmtRow(cols));
  print(fmtRow(widths.map(w => "-".repeat(w))));
  for (const row of rows) {
    print(fmtRow(cols.map(c => String(row[c] === null || row[c] === undefined ? "" : row[c]))));
  }
  print(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

const NO_ARTIFACTS = "No artifacts found under target/. Run `sqlanvil compile` (or `run`) first.";

async function runQuery(projectDir: string, sql: string, json: boolean): Promise<number> {
  const { views, hasCatalog } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const rows = await queryParquet(sql, views);
  if (json) {
    print(prettyJsonStringify(rows));
  } else {
    printArtifactRows(rows);
  }
  return 0;
}

async function runInspect(projectDir: string, json: boolean): Promise<number> {
  const { views, hasCatalog, hasRuns } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const actionsByType = await queryParquet(
    "select type, count(*) as n from actions group by type order by type",
    views
  );
  let latestRun: any = null;
  let failures: any[] = [];
  if (hasRuns) {
    const latest = await queryParquet(
      "select run_id, run_status, " +
        "count(*) filter (where status = 'SUCCESSFUL') as succeeded, " +
        "count(*) filter (where status = 'FAILED') as failed, " +
        "max(end_millis) - min(start_millis) as wall_ms " +
        "from runs where run_id = (select max(run_id) from runs) group by run_id, run_status",
      views
    );
    latestRun = latest[0] || null;
    failures = await queryParquet(
      "select readable_name, error_message from runs " +
        "where run_id = (select max(run_id) from runs) and status = 'FAILED' limit 20",
      views
    );
  }

  if (json) {
    print(prettyJsonStringify({ actionsByType, latestRun, failures }));
    return 0;
  }
  print("Actions by type:");
  printArtifactRows(actionsByType);
  if (!hasRuns || !latestRun) {
    print("\nNo runs recorded yet.");
  } else {
    print(
      `\nLatest run (${latestRun.run_status}): ${latestRun.succeeded} succeeded, ` +
        `${latestRun.failed} failed, ${latestRun.wall_ms}ms`
    );
    if (failures.length > 0) {
      print("\nFailures:");
      printArtifactRows(failures);
    }
  }
  return 0;
}

async function runDocs(projectDir: string): Promise<number> {
  const { views, hasCatalog } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const model = await buildDocsModel(views, new Date().toISOString());
  const html = renderDocsHtml(model);
  const outDir = path.join(projectDir, TARGET_DIR, "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "index.html");
  fs.writeFileSync(outFile, html);
  printSuccess(`Wrote catalog to ${outFile}`);
  return 0;
}

export function runCli() {
  const builtYargs = createYargsCli({
    commands: [
      {
        // This dummy command is a hack with the only goal of displaying "help" as a command in the CLI
        // and we need it because of the limitations of yargs considering "help" as an option and not as a command.
        format: "help [command]",
        description: "Show help. If [command] is specified, the help is for the given command.",
        positionalOptions: [],
        options: [],
        processFn: async () => {
          return 0;
        }
      },
      {
        format:
          `init [${projectDirOption.name}] [${ProjectConfigOptions.defaultDatabase.name}]` +
          ` [${ProjectConfigOptions.defaultLocation.name}]`,
        description: "Create a new sqlanvil project (BigQuery, Postgres, or Supabase).",
        positionalOptions: [
          projectDirOption,
          positionalOption(
            ProjectConfigOptions.defaultDatabase.name,
            {
              describe: "The default database to use, equivalent to Google Cloud Project ID."
            },
            (argv: InitArgv) => {
              const warehouse = argv[warehouseOption.name] || "bigquery";
              if (warehouse === "bigquery" && !argv[ProjectConfigOptions.defaultDatabase.name]) {
                throw new Error(
                  `The ${ProjectConfigOptions.defaultDatabase.name} positional argument is ` +
                    `required for BigQuery projects. Use "sqlanvil help init" for more info.`
                );
              }
            }
          ),
          positionalOption(
            ProjectConfigOptions.defaultLocation.name,
            {
              describe:
                "The default location to use. See " +
                "https://cloud.google.com/bigquery/docs/locations for supported values."
            },
            (argv: InitArgv) => {
              const warehouse = argv[warehouseOption.name] || "bigquery";
              if (warehouse === "bigquery" && !argv[ProjectConfigOptions.defaultLocation.name]) {
                throw new Error(
                  `The ${ProjectConfigOptions.defaultLocation.name} positional argument is ` +
                    `required for BigQuery projects. Use "sqlanvil help init" for more info.`
                );
              }
            }
          )
        ],
        options: [warehouseOption, icebergOption],
        processFn: async (argv: InitArgv) => {
          const projectDir = argv[projectDirOption.name];
          const warehouse = argv[warehouseOption.name] || "bigquery";
          const projectConfig: sqlanvil.IProjectConfig = { warehouse };
          if (warehouse === "bigquery") {
            projectConfig.defaultDatabase = argv[ProjectConfigOptions.defaultDatabase.name];
            projectConfig.defaultLocation = argv[ProjectConfigOptions.defaultLocation.name];
          }

          if (argv[icebergOption.name]) {
            const icebergConfig = promptForIcebergConfig();
            if(icebergConfig) {
              projectConfig.defaultIcebergConfig = icebergConfig;
            }
          }

          print("Writing project files...\n");

          const initResult = await init(projectDir, projectConfig);
          printInitResult(initResult);
          return 0;
        }
      },
      {
        format: `install [${projectDirMustExistOption.name}]`,
        description: "Install a project's NPM dependencies.",
        positionalOptions: [projectDirMustExistOption],
        options: [],
        processFn: async (argv: InstallArgv) => {
          print("Installing NPM dependencies...\n");
          await install(argv[projectDirMustExistOption.name]);
          printSuccess("Project dependencies successfully installed.");
          return 0;
        }
      },
      {
        format: `init-creds [${projectDirMustExistOption.name}]`,
        description:
          `Create a ${credentials.CREDENTIALS_FILENAME} file for sqlanvil to use when ` +
          `accessing BigQuery.`,
        positionalOptions: [projectDirMustExistOption],
        options: [
          option(testConnectionOptionName, {
            describe: "If true, a test query will be run using your final credentials.",
            type: "boolean",
            default: true
          })
        ],
        processFn: async (argv: InitCredsArgv) => {
          const finalCredentials = getBigQueryCredentials();
          if (argv[testConnectionOptionName]) {
            print("\nRunning connection test...");
            const dbadapter = new BigQueryDbAdapter(finalCredentials);
            const testResult = await credentials.test(dbadapter);
            switch (testResult.status) {
              case credentials.TestResultStatus.SUCCESSFUL: {
                printSuccess("\nCredentials test query completed successfully.\n");
                break;
              }
              case credentials.TestResultStatus.TIMED_OUT: {
                throw new Error("Credentials test connection timed out.");
              }
              case credentials.TestResultStatus.OTHER_ERROR: {
                throw new Error(
                  `Credentials test query failed: ${testResult.error.stack ||
                    testResult.error.message}`
                );
              }
            }
          } else {
            print("\nCredentials test query was not run.\n");
          }
          const filePath = path.resolve(
            argv[projectDirMustExistOption.name],
            credentials.CREDENTIALS_FILENAME
          );
          fs.writeFileSync(filePath, prettyJsonStringify(finalCredentials));
          printInitCredsResult(filePath);
          return 0;
        }
      },
      {
        format: `compile [${projectDirMustExistOption.name}]`,
        description:
          "Compile the sqlanvil project. Produces JSON output describing the non-executable graph.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          option(watchOptionName, {
            describe: "Whether to watch the changes in the project directory.",
            type: "boolean",
            default: false
          }),
          jsonOutputOption,
          dotOutputOption,
          timeoutOption,
          quietCompileOption,
          compileActionsOption,
          compileTagsOption,
          compileIncludeDepsOption,
          compileIncludeDependentsOption,
          noArtifactsOption,
          option(
            verboseOptionName,
            {
              describe:
                "Enable verbose compilation output. Example usage: 'sqlanvil compile --verbose'",
              type: "boolean",
              default: false
            },
            (argv: { quiet?: boolean; verbose?: boolean }) => {
              if (argv.quiet && argv.verbose) {
                throw new Error("Arguments --verbose and --quiet are mutually exclusive.");
              }
            }
          ),
          ...ProjectConfigOptions.allYargsOptions
        ],
        processFn: async (argv: CompileArgv) => {
          const projectDir = argv[projectDirMustExistOption.name];

          async function compileAndPrint() {

            let outputType = compiledGraphOutputType.Summary;
            if (argv[jsonOutputOption.name]) {
              outputType = compiledGraphOutputType.Json;
            } else if (argv[dotOutputOption.name]) {
              outputType = compiledGraphOutputType.Dot;
            } 
            
            if (outputType === compiledGraphOutputType.Summary) {
              print("Compiling...\n");
            }
            const compiledGraph = await compile({
              projectDir,
              projectConfigOverride: projectConfigOverrideWithEnvironment(projectDir, argv),
              timeoutMillis: argv[timeoutOption.name] || undefined,
              verbose: argv[verboseOptionName] || false
            });

            // The whole project must compile (ref() resolution needs every action
            // registered), but the printed output can be filtered to the selected
            // action(s) — mirroring how `run`/`build` prune the graph. We only prune
            // a clean graph; if compilation produced errors we print the full graph
            // plus the errors, keeping graph-level errors as-is.
            const hasSelector =
              argv[actionsOption.name]?.length > 0 || argv[tagsOption.name]?.length > 0;
            const outputGraph =
              hasSelector && !compiledGraphHasErrors(compiledGraph)
                ? prune(compiledGraph, {
                    actions: argv[actionsOption.name],
                    tags: argv[tagsOption.name],
                    includeDependencies: argv[includeDepsOption.name],
                    includeDependents: argv[includeDependentsOption.name]
                  })
                : compiledGraph;
            printCompiledGraph(outputGraph, outputType, argv[quietCompileOption.name]);
            if (compiledGraphHasErrors(compiledGraph)) {
              print("");
              printCompiledGraphErrors(compiledGraph.graphErrors, argv[quietCompileOption.name]);
              return true;
            }
            // Write the queryable catalog (best-effort) for `sqlanvil query` / `inspect`.
            if (!(argv as any)[noArtifactsOption.name]) {
              await safeWriteArtifacts(compiledGraph, projectDir, { warn: print });
            }
            return false;
          }

          const graphHasErrors = await compileAndPrint();

          if (!argv[watchOptionName]) {
            return graphHasErrors ? 1 : 0;
          }

          let watching = true;

          let timeoutID: NodeJS.Timer = null;
          let isCompiling = false;

          // Initialize watcher.
          const watcher = chokidar.watch(projectDir, {
            ignored: /node_modules/,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 1000,
              pollInterval: 200
            }
          });

          const printReady = () => {
            print("\nWatching for changes...\n");
          };
          // Add event listeners.
          watcher
            .on("ready", printReady)
            .on("error", error => {
              // This error is caught not if there is a compilation error, but
              // if the watcher fails; this indicates an failure on our side.
              printError(`Error: ${error}`);
              process.exit(1);
            })
            .on("all", () => {
              if (timeoutID || isCompiling) {
                // don't recompile many times if we changed a lot of files
                clearTimeout(timeoutID);
              }

              timeoutID = setTimeout(async () => {
                clearTimeout(timeoutID);

                if (!isCompiling) {
                  isCompiling = true;
                  await compileAndPrint();
                  printReady();
                  isCompiling = false;
                }
              }, RECOMPILE_DELAY);
            });
          process.on("SIGINT", async () => {
            await watcher.close();
            watching = false;
            process.exit(1);
          });
          while (watching) {
            await new Promise((resolve, reject) => setTimeout(() => resolve(), 100));
          }
        }
      },
      {
        format: `test [${projectDirMustExistOption.name}]`,
        description: "Run the sqlanvil project's unit tests.",
        positionalOptions: [projectDirMustExistOption],
        options: [credentialsOption, timeoutOption, jsonOutputOption, ...ProjectConfigOptions.allYargsOptions],
        processFn: async (argv: TestArgv) => {
          if (!argv[jsonOutputOption.name]) {
            print("Compiling...\n");
          }
          const compiledGraph = await compile({
            projectDir: argv[projectDirMustExistOption.name],
            projectConfigOverride: projectConfigOverrideWithEnvironment(
              argv[projectDirMustExistOption.name],
              argv
            ),
            timeoutMillis: argv[timeoutOption.name] || undefined
          });
          if (compiledGraphHasErrors(compiledGraph)) {
            printCompiledGraphErrors(compiledGraph.graphErrors, argv[quietCompileOption.name]);
            return 1;
          }
          if (!argv[jsonOutputOption.name]) {
            printSuccess("Compiled successfully.\n");
          }   
          const warehouse = compiledGraph.projectConfig.warehouse || "bigquery";
          const readCredentials = credentials.read(
            credentialsPathWithEnvironment(argv[projectDirMustExistOption.name], argv),
            warehouse
          );

          if (!compiledGraph.tests.length) {
            printError("No unit tests found.");
            return 1;
          }

          if (!argv[jsonOutputOption.name]) {
            print(`Running ${compiledGraph.tests.length} unit tests...\n`);
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
          const testResults = await test(dbadapter, compiledGraph.tests);
          if (!argv[jsonOutputOption.name]) {
            testResults.forEach(testResult => printTestResult(testResult));
          } else {
            // Print all results as JSON if the option is set.
            print(prettyJsonStringify(testResults));
          }
          return testResults.every(testResult => testResult.successful) ? 0 : 1;
        }
      },
      {
        format: `validate [${projectDirMustExistOption.name}]`,
        description:
          "Validate the project's SQL against the warehouse planner (EXPLAIN/dry-run) without " +
          "executing. Postgres/Supabase/MySQL only.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          actionsOption,
          tagsOption,
          includeDepsOption,
          includeDependentsOption,
          credentialsOption,
          jsonOutputOption,
          timeoutOption,
          keepShadowOption,
          ...ProjectConfigOptions.allYargsOptions
        ],
        processFn: async (argv: any) => runValidate(argv)
      },
      {
        format: `run [${projectDirMustExistOption.name}]`,
        description: "Run the sqlanvil project.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          option(dryRunOptionName, {
            describe:
              "If set, BigQuery will validate the run SQL without applying changes to the warehouse.",
            type: "boolean"
          }),
          option(runTestsOptionName, {
            describe:
              "If set, the project's unit tests are required to pass before running the project.",
            type: "boolean"
          }),
          option(actionRetryLimitName, {
            describe: "If set, idempotent actions will be retried up to the limit.",
            type: "number",
            default: 0
          }),
          actionsOption,
          credentialsOption,
          fullRefreshOption,
          graphFileOption,
          includeDepsOption,
          includeDependentsOption,
          credentialsOption,
          jsonOutputOption,
          timeoutOption,
          tagsOption,
          bigqueryJobLabelsOption,
          noArtifactsOption,
          ...ProjectConfigOptions.allYargsOptions
        ],
        processFn: async (argv: RunArgv) => {
          if (argv[jsonOutputOption.name] && !argv[dryRunOptionName]) {
            print(
              `For execution, the --${jsonOutputOption.name} option is only supported if the ` +
                `--${dryRunOptionName} option is enabled`
            );
            return;
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
                  `explicitly for this run.`
              );
              return 1;
            }
            assertPathExists(graphPath);
            try {
              compiledGraph = sqlanvil.CompiledGraph.fromObject(
                JSON.parse(fs.readFileSync(graphPath, "utf8"))
              );
            } catch (e) {
              printError(`Failed to load compiled graph from ${graphPath}: ${(e as Error).message}`);
              return 1;
            }
            const graphCore = compiledGraph.sqlanvilCoreVersion;
            const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");
            if (graphCore && majorMinor(graphCore) !== majorMinor(sqlanvilVersion)) {
              print(
                `WARNING: graph was compiled by core ${graphCore}; this CLI is ${sqlanvilVersion}. ` +
                  `Recompile the graph if the run misbehaves.\n`
              );
            }
            if (!argv[jsonOutputOption.name]) {
              printSuccess(
                `Loaded compiled graph (core ${graphCore || "unknown"}) from ${graphPath}\n`
              );
            }
          } else {
            if (!argv[jsonOutputOption.name]) {
              print("Compiling...\n");
            }
            compiledGraph = await compile({
              projectDir: argv[projectDirOption.name],
              projectConfigOverride: projectConfigOverrideWithEnvironment(
                argv[projectDirOption.name],
                argv
              ),
              timeoutMillis: argv[timeoutOption.name] || undefined
            });
            if (!argv[jsonOutputOption.name] && !compiledGraphHasErrors(compiledGraph)) {
              printSuccess("Compiled successfully.\n");
            }
          }
          if (compiledGraphHasErrors(compiledGraph)) {
            printCompiledGraphErrors(compiledGraph.graphErrors, argv[quietCompileOption.name]);
            return 1;
          }
          const warehouse = compiledGraph.projectConfig.warehouse || "bigquery";

          // On Postgres/Supabase/MySQL there is no warehouse-native dry-run, and proceeding to
          // run() would APPLY changes — so `run --dry-run` there means "validate": EXPLAIN every
          // model in an isolated shadow namespace without executing. (BigQuery keeps its own
          // server-side dry-run below.) Delegated to the shared validate flow, which re-compiles
          // into the shadow namespace.
          if (argv[dryRunOptionName] && warehouse.toLowerCase() !== "bigquery") {
            if (graphPath) {
              printError(
                `--${dryRunOptionName} on ${warehouse} validates by recompiling the project source, ` +
                  `which --${graphFileOption.name} bypasses. Run \`sqlanvil validate\` on the project instead.`
              );
              return 1;
            }
            return runValidate(argv);
          }

          const readCredentials = credentials.read(
            credentialsPathWithEnvironment(argv[projectDirOption.name], argv),
            warehouse
          );

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
              tags: argv[tagsOption.name]
            },
            dbadapter
          );

          if (argv[dryRunOptionName] && argv[jsonOutputOption.name]) {
            printExecutionGraph(executionGraph, argv[jsonOutputOption.name]);
            return;
          }

          if (argv[runTestsOptionName]) {
            print(`Running ${compiledGraph.tests.length} unit tests...\n`);
            const testResults = await test(dbadapter, compiledGraph.tests);
            testResults.forEach(testResult => printTestResult(testResult));
            if (testResults.some(testResult => !testResult.successful)) {
              printError("\nUnit tests did not pass; aborting run.");
              return 1;
            }
            printSuccess("Unit tests completed successfully.\n");
          }

          let bigqueryOptions: {} = {
            actionRetryLimit: argv[actionRetryLimitName]
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
          executionGraph.actions.forEach(action => {
            actionsByName.set(targetAsReadableString(action.target), action);
          });

          if (actionsByName.size === 0) {
            print("No actions to run.\n");
            return 0;
          }

          // Source-connection creds for FDW-bridge user mappings. Read here (not in the
          // --dry-run --json path above) and validated fail-fast before anything executes.
          const connectionCredentials = credentials.readConnections(
            credentialsPathWithEnvironment(argv[projectDirOption.name], argv)
          );
          assertConnectionCredentialsAvailable(executionGraph, connectionCredentials);

          // For runner-side DuckDB exports (Postgres/Supabase): the source DB connection to
          // ATTACH, plus object-store credentials. Ignored on BigQuery (exports run in-engine).
          const storageCredentials = credentials.readStorageCredentials(
            credentialsPathWithEnvironment(argv[projectDirOption.name], argv)
          );
          const isPostgresLike =
            warehouse.toLowerCase() === "postgres" || warehouse.toLowerCase() === "supabase";

          if (argv[dryRunOptionName]) {
            print("Dry running (no changes to the warehouse will be applied)...");
          } else {
            print("Running...\n");
          }

          const runner = run(dbadapter, executionGraph, {
            bigquery: bigqueryOptions,
            connectionCredentials,
            warehouseConnection: isPostgresLike ? readCredentials : undefined,
            storageCredentials
          });
          process.on("SIGINT", () => {
            runner.cancel();
          });

          const alreadyPrintedActions = new Set<string>();

          const printExecutedGraph = (executedGraph: sqlanvil.IRunResult) => {
            executedGraph.actions
              .filter(
                actionResult =>
                  actionResult.status !== sqlanvil.ActionResult.ExecutionStatus.RUNNING
              )
              .filter(
                executedAction =>
                  !alreadyPrintedActions.has(targetAsReadableString(executedAction.target))
              )
              .forEach(executedAction => {
                printExecutedAction(
                  executedAction,
                  actionsByName.get(targetAsReadableString(executedAction.target)),
                  argv[dryRunOptionName]
                );
                alreadyPrintedActions.add(targetAsReadableString(executedAction.target));
              });
          };

          runner.onChange(printExecutedGraph);
          const runResult = await runner.result();
          printExecutedGraph(runResult);
          if (!(argv as any)[noArtifactsOption.name]) {
            await safeWriteArtifacts(compiledGraph, argv[projectDirOption.name], {
              runResult,
              runId: Date.now(),
              warn: print
            });
          }
          return runResult.status === sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL ? 0 : 1;
        }
      },
      {
        format: `query [sql] [${projectDirOption.name}]`,
        description:
          "Run SQL over the project's queryable artifacts in target/ (views: actions, " +
          "dependencies, columns, runs), via the bundled DuckDB.",
        positionalOptions: [
          positionalOption(
            "sql",
            { describe: 'SQL to run, e.g. "select type, count(*) from actions group by 1".' },
            (argv: { sql?: string }) => {
              if (!argv.sql) {
                throw new Error(
                  'Provide a SQL query, e.g. sqlanvil query "select * from actions".'
                );
              }
            }
          ),
          projectDirOption
        ],
        options: [jsonOutputOption],
        processFn: async (argv: any) =>
          runQuery(argv[projectDirOption.name], argv.sql, argv[jsonOutputOption.name])
      },
      {
        format: `inspect [${projectDirOption.name}]`,
        description:
          "Summarize the project's artifacts: action counts by type, the latest run's status/" +
          "timing, and recent failures.",
        positionalOptions: [projectDirOption],
        options: [jsonOutputOption],
        processFn: async (argv: any) =>
          runInspect(argv[projectDirOption.name], argv[jsonOutputOption.name])
      },
      {
        format: `docs [${projectDirOption.name}]`,
        description:
          "Generate a self-contained HTML catalog of the project (models, columns, dependencies, " +
          "last-run status) at target/docs/index.html, from the artifacts.",
        positionalOptions: [projectDirOption],
        options: [],
        processFn: async (argv: any) => runDocs(argv[projectDirOption.name])
      },
      {
        format: `format [${projectDirMustExistOption.name}]`,
        description: "Format the sqlanvil project's files.",
        positionalOptions: [projectDirMustExistOption],
        options: [
          actionsOption,
          option(checkOptionName, {
            describe: "Check if files are formatted correctly without modifying them.",
            type: "boolean",
            default: false
          })
        ],
        processFn: async (argv: FormatArgv) => {
          let actions = ["{definitions,includes}/**/*.{js,sqlx}"];
          if (actionsOption.name in argv && argv[actionsOption.name].length > 0) {
            actions = argv[actionsOption.name];
          }
          const filenames = actions
            .map((action: string) =>
              glob.sync(action, { cwd: argv[projectDirMustExistOption.name] })
            )
            .flat();

          const isCheckMode = argv[checkOptionName];
          const results: Array<{
            filename: string;
            err?: Error;
            needsFormatting?: boolean;
          }> = await Promise.all(
            filenames.map(async (filename: string) => {
              try {
                const filePath = path.resolve(argv[projectDirMustExistOption.name], filename);
                if (isCheckMode) {
                  // In check mode, we don't modify files, just check if they need formatting
                  const fileContent = fs.readFileSync(filePath).toString();
                  const formattedContent = await formatFile(filePath, {
                    overwriteFile: false
                  });
                  return {
                    filename,
                    needsFormatting: fileContent !== formattedContent
                  };
                } else {
                  // Normal formatting mode
                  await formatFile(filePath, {
                    overwriteFile: true
                  });
                  return {
                    filename
                  };
                }
              } catch (e) {
                return {
                  filename,
                  err: e
                };
              }
            })
          );

          printFormatFilesResult(results);

          // Return error code if there are any formatting errors
          const failedFormatResults = results.filter(result => !!result.err);
          if (failedFormatResults.length > 0) {
            printError(`${failedFormatResults.length} file(s) failed to format.`);
            return 1;
          }

          // In check mode, return an error code if any files need formatting
          if (isCheckMode) {
            const filesNeedingFormatting = results.filter(result => result.needsFormatting);
            if (filesNeedingFormatting.length > 0) {
              printError(
                `${filesNeedingFormatting.length} file(s) would be reformatted. Run the format command without --check to update.`
              );
              return 1;
            }
            printSuccess("All files are formatted correctly!");
          }

          return 0;
        }
      },
      {
        format: `introspect <connection> <tableRef> [${projectDirOption.name}]`,
        description:
          "Read a source table's schema from a connection and write a declaration .sqlx with columnTypes.",
        positionalOptions: [
          positionalOption("connection", {
            describe: "Connection name (from workflow_settings.yaml connections)."
          }),
          positionalOption("tableRef", {
            describe: "Source table as schema.table (or just table)."
          }),
          projectDirOption
        ],
        options: [
          option("output", {
            describe: "File to write the declaration .sqlx to. Prints to stdout if omitted.",
            type: "string"
          })
        ],
        processFn: async (argv: IntrospectArgv) => {
          const projectDir = argv[projectDirOption.name];
          const sqlx = await introspectToSqlx(projectDir, argv.connection, argv.tableRef);
          if (argv.output) {
            fs.writeFileSync(argv.output, sqlx);
            printSuccess(`Wrote declaration to ${argv.output}`);
          } else {
            print(sqlx);
          }
          return 0;
        }
      }
    ]
  })
    .scriptName("sqlanvil")
    .strict()
    .wrap(null)
    .recommendCommands()
    .fail(async (msg: string, err: Error) => {
      if (!!err && err.name === "VMError" && err.message.includes("Cannot find module")) {
        printError("Could not find NPM dependencies. Have you run 'sqlanvil install'?");
      } else {
        const message = err?.message ? err.message.split("\n")[0] : msg;
        printError(`sqlanvil encountered an error: ${message}`);
        if (err?.stack) {
          printError(err.stack);
        }
      }
      process.exit(1);
    }).argv;

  // If no command is specified, show top-level help string.
  if (!builtYargs._[0]) {
    yargs.showHelp();
  }
}

class ProjectConfigOptions {
  public static defaultDatabase = option("default-database", {
    describe:
      "The default database to use, equivalent to Google Cloud Project ID. If unset, " +
      "the value from workflow_settings.yaml is used.",
    type: "string"
  });

  public static defaultSchema = option("default-schema", {
    describe:
      "Override for the default schema name. If unset, the value from workflow_settings.yaml is used."
  });

  public static defaultLocation = option("default-location", {
    describe:
      "The default location to use. See " +
      "https://cloud.google.com/bigquery/docs/locations for supported values. If unset, the " +
      "value from workflow_settings.yaml is used."
  });

  public static assertionSchema = option("assertion-schema", {
    describe: "Default assertion schema. If unset, the value from workflow_settings.yaml is used."
  });

  public static databaseSuffix = option("database-suffix", {
    describe: "Default assertion schema. If unset, the value from workflow_settings.yaml is used."
  });

  public static vars = option("vars", {
    describe:
      "Override for variables to inject via '--vars=someKey=someValue,a=b', referenced by " +
      "`sqlanvil.projectConfig.vars.someValue`.  If unset, the value from workflow_settings.yaml is used.",
    type: "string",
    default: null,
    coerce: (rawVarsString: string | null) => {
      const variables: { [key: string]: string } = {};
      rawVarsString?.split(",").forEach(keyValueStr => {
        const [key, value] = keyValueStr.split("=");
        variables[key] = value;
      });
      return variables;
    }
  });

  public static schemaSuffix = option(
    "schema-suffix",
    {
      describe:
        "A suffix to be appended to output schema names. If unset, the value from workflow_settings.yaml " +
        "is used."
    },
    (argv: Pick<ProjectConfigArgv, "schema-suffix">) => {
      if (
        argv[ProjectConfigOptions.schemaSuffix.name] &&
        !/^[a-zA-Z_0-9]+$/.test(argv[ProjectConfigOptions.schemaSuffix.name])
      ) {
        throw new Error(
          `--${ProjectConfigOptions.schemaSuffix.name} should contain only ` +
            `alphanumeric characters and/or underscores.`
        );
      }
    }
  );

  public static tablePrefix = option("table-prefix", {
    describe:
      "Adds a prefix for all table names. If unset, the value from workflow_settings.yaml is used."
  });

  public static disableAssertions = option("disable-assertions", {
    describe:
      "Disables all assertions including built-in assertions (uniqueKey, nonNull, rowConditions) and manual assertions (type: assertion).",
    type: "boolean",
    default: false
  });

  public static defaultReservation = option("default-reservation", {
    describe:
      "The default BigQuery reservation to use for execution. If unset, the value from " +
      "workflow_settings.yaml is used. If neither is set, default BigQuery behavior applies.",
    type: "string"
  });

  public static environment = option("environment", {
    describe:
      "Named environment from workflow_settings.yaml `environments:` to load (its schemaSuffix, " +
      "vars, defaultDatabase/location, and credentials file). Explicit flags override the environment.",
    type: "string"
  });

  public static allYargsOptions = [
    ProjectConfigOptions.defaultDatabase,
    ProjectConfigOptions.defaultSchema,
    ProjectConfigOptions.defaultLocation,
    ProjectConfigOptions.assertionSchema,
    ProjectConfigOptions.vars,
    ProjectConfigOptions.databaseSuffix,
    ProjectConfigOptions.schemaSuffix,
    ProjectConfigOptions.tablePrefix,
    ProjectConfigOptions.disableAssertions,
    ProjectConfigOptions.defaultReservation,
    ProjectConfigOptions.environment
  ];

  public static constructProjectConfigOverride(
    argv: ProjectConfigArgv
  ): sqlanvil.IProjectConfig {
    const projectConfigOptions: sqlanvil.IProjectConfig = {};

    if (argv[ProjectConfigOptions.defaultDatabase.name]) {
      projectConfigOptions.defaultDatabase = argv[ProjectConfigOptions.defaultDatabase.name];
    }
    if (argv[ProjectConfigOptions.defaultSchema.name]) {
      projectConfigOptions.defaultSchema = argv[ProjectConfigOptions.defaultSchema.name];
    }
    if (argv[ProjectConfigOptions.defaultLocation.name]) {
      projectConfigOptions.defaultLocation = argv[ProjectConfigOptions.defaultLocation.name];
    }
    if (argv[ProjectConfigOptions.assertionSchema.name]) {
      projectConfigOptions.assertionSchema = argv[ProjectConfigOptions.assertionSchema.name];
    }
    if (argv[ProjectConfigOptions.vars.name]) {
      projectConfigOptions.vars = argv[ProjectConfigOptions.vars.name];
    }
    if (argv[ProjectConfigOptions.databaseSuffix.name]) {
      projectConfigOptions.databaseSuffix = argv[ProjectConfigOptions.databaseSuffix.name];
    }
    if (argv[ProjectConfigOptions.schemaSuffix.name]) {
      projectConfigOptions.schemaSuffix = argv[ProjectConfigOptions.schemaSuffix.name];
    }
    if (argv[ProjectConfigOptions.tablePrefix.name]) {
      projectConfigOptions.tablePrefix = argv[ProjectConfigOptions.tablePrefix.name];
    }
    if (argv[ProjectConfigOptions.disableAssertions.name]) {
      projectConfigOptions.disableAssertions = argv[ProjectConfigOptions.disableAssertions.name];
    }
    if (argv[ProjectConfigOptions.defaultReservation.name]) {
      projectConfigOptions.defaultReservation = argv[ProjectConfigOptions.defaultReservation.name];
    }
    return projectConfigOptions;
  }
}
