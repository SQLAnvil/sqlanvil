import { compile, credentials, prune } from "sa/cli/api";
import { checkScriptAction } from "sa/cli/api/commands/script_env";
import { sweepOrphanShadows, validate, ValidateDeps } from "sa/cli/api/commands/validate";
import {
  rewriteSelfReferences,
  ValidationResult,
  validateShadowSuffix
} from "sa/cli/api/commands/validate_graph";
import { IDbAdapter } from "sa/cli/api/dbadapters";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  actionsOption,
  credentialsOption,
  credentialsPathWithEnvironment,
  includeDependentsOption,
  includeDepsOption,
  jsonOutputOption,
  projectConfigOverrideWithEnvironment,
  projectDirMustExistOption,
  projectDirOption,
  tagsOption,
  timeoutOption
} from "sa/cli/common_options";
import { print, printCompiledGraphErrors, printError, printSuccess } from "sa/cli/console";
import { ProjectConfigOptions } from "sa/cli/project_config_options";
import { compiledGraphHasErrors } from "sa/cli/util";
import { ICommand, option } from "sa/cli/yargswrapper";
import { targetAsReadableString } from "sa/core/targets";
import { dataformVersion } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";

const keepShadowOption = option("keep-shadow", {
  describe:
    "If set, `validate` leaves its temporary shadow schema(s) in place instead of dropping them " +
    "(debugging aid).",
  type: "boolean"
});

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
export async function runValidate(argv: any): Promise<number> {
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
    printCompiledGraphErrors(compiledGraph.graphErrors);
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

  // Self-references (`${self()}`) must read the PRODUCTION relation, not the shadow (issue #49).
  rewriteSelfReferences(prunedGraph, shadowSuffix, target => executionSql.resolveTarget(target));

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
    // Pre/post-ops are dry-run against the action's fresh shadow stub — only BigQuery's
    // planner can dry-run DDL (Postgres/MySQL EXPLAIN rejects it, so ops aren't validated there).
    evaluateOp: warehouse === "bigquery" ? (sql: string) => dbadapter.evaluate(sql) : undefined,
    execute: sql => dbadapter.execute(sql).then(() => undefined),
    validationStubSql: table => executionSql.validationStubSql(table),
    createSchemaSql: schema => executionSql.createSchemaSql(schema),
    dropSchemaCascadeSql: schema => executionSql.dropSchemaCascadeSql(schema),
    listSchemas: async () => {
      const result = await dbadapter.execute(
        "select schema_name as name from information_schema.schemata"
      );
      return ((result && result.rows) || []).map((row: any) => row.name);
    },
    // Script actions: interpreter/requirements/syntax check via the resolved interpreter
    // (warehouse-independent — nothing is installed or executed).
    checkScript: script => checkScriptAction(script, projectDir)
  };

  // Best-effort: clear shadow schemas orphaned by previously-killed validate runs.
  await sweepOrphanShadows(deps, Date.now());

  if (!argv[jsonOutputOption.name]) {
    print("Validating...\n");
  }
  const results = await validate(prunedGraph, deps, { keepShadow: argv[keepShadowOption.name] });
  return printValidationResults(results, argv[jsonOutputOption.name]);
}

export const validateCommand: ICommand = {
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
};
