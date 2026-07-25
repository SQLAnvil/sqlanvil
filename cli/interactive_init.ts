import { spawnSync } from "child_process";
import * as fs from "fs";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import * as path from "path";

import { init } from "sa/cli/api";
import { CREDENTIALS_FILENAME } from "sa/cli/api/commands/credentials";
import { migrateDataform, MigrationReport } from "sa/cli/api/commands/migrate_dataform";
import {
  interactivePasswordQuestion,
  interactiveQuestion,
  print,
  printError,
  printInitResult,
  printSuccess
} from "sa/cli/console";
import { actuallyResolve } from "sa/cli/util";
import { sqlanvil } from "sa/protos/ts";

// Question texts are exported so tests can key DATAFORM_CLI_TEST_INPUTS on the exact strings
// (interactiveQuestion matches on the displayed text, including the `[default]` suffix — see
// withDefault).
export const INIT_MODE_QUESTION =
  "Start a fresh project, or convert an existing Dataform project? (fresh/convert)";
export const INIT_WAREHOUSE_QUESTION = "Which warehouse? (supabase/postgres/bigquery/mysql)";
export const INIT_PROJECT_DIR_QUESTION = "Project directory?";
export const INIT_BQ_PROJECT_QUESTION =
  "Google Cloud project ID (the default project models build in)?";
export const INIT_BQ_LOCATION_QUESTION = "Default BigQuery location (e.g. US, us-central1)?";
export const INIT_DEFAULT_SCHEMA_QUESTION = "Default schema for models?";
export const INIT_INCLUDE_SAMPLE_QUESTION =
  "Include the sample project (sources -> staging views -> outputs -> assertion)?";
export const INIT_INCLUDE_BQ_SOURCE_QUESTION =
  "Include the cross-warehouse BigQuery sample source (Google public ZIP data)?";
export const INIT_CONFIGURE_CREDS_QUESTION =
  `Configure warehouse credentials now (written to the gitignored ${CREDENTIALS_FILENAME})?`;
export const CREDS_HOST_QUESTION = "Host?";
export const CREDS_PORT_QUESTION = "Port?";
export const CREDS_DATABASE_QUESTION = "Database?";
export const CREDS_USER_QUESTION = "User?";
export const CREDS_PASSWORD_QUESTION = "Password? (leave empty to fill in later)";
export const CREDS_SSLMODE_QUESTION = "SSL mode? (disable/require)";
export const CONVERT_SOURCE_QUESTION =
  "Path to the Dataform project to convert (read-only, never modified)?";
export const CONVERT_OUT_QUESTION =
  "Directory for the converted sqlanvil project (created; must be empty)?";
export const CONVERT_TARGET_QUESTION =
  "Target warehouse? (bigquery = keep running on BigQuery, tooling swap only; supabase/postgres = move off BigQuery)";
export const BQ_AUTH_QUESTION =
  "How should local runs authenticate to BigQuery? (adc = gcloud Application Default " +
  "Credentials, like Dataform local runs; key = service-account key file; later)";
export const BQ_AUTH_LOGIN_QUESTION =
  "No Application Default Credentials found. Run `gcloud auth application-default login` now?";
export const BQ_KEY_PATH_QUESTION = "Path to the service-account key JSON file?";
export const BQ_TEST_TARGET_QUESTION =
  "Where should test runs land before you touch production? (suffix = same project, " +
  "`<dataset>_test` datasets; project = a separate GCP project; none = no test environment)";
export const BQ_TEST_SUFFIX_QUESTION = "Dataset suffix for the test environment?";
export const BQ_TEST_PROJECT_QUESTION = "GCP project ID for the test environment?";

export const SUPABASE_POOLER_HINT =
  "Use the SESSION POOLER connection (Supabase Dashboard -> Connect -> Session pooler): host " +
  "aws-<n>-<region>.pooler.supabase.com, user postgres.<project-ref>. The direct " +
  "db.<ref>.supabase.co host is IPv6-only and unreachable from most networks.";

// Bounded retries so a mis-piped stdin (EOF -> empty answers forever) can't spin the CLI.
const MAX_ATTEMPTS = 20;

/** The exact prompt text displayed for a question with a default answer. */
export function withDefault(question: string, defaultValue?: string): string {
  return defaultValue ? `${question} [${defaultValue}]` : question;
}

function ask(question: string, defaultValue?: string): string {
  const answer = interactiveQuestion(withDefault(question, defaultValue)).trim();
  return answer === "" ? defaultValue ?? "" : answer;
}

function askRequired(question: string): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = ask(question);
    if (answer !== "") {
      return answer;
    }
    printError("A value is required.");
  }
  throw new Error(`No answer provided for: ${question}`);
}

function askChoice(question: string, choices: string[], defaultValue: string): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = ask(question, defaultValue).toLowerCase();
    if (choices.includes(answer)) {
      return answer;
    }
    printError(`Please answer one of: ${choices.join(", ")}.`);
  }
  throw new Error(`No valid answer provided for: ${question}`);
}

function askYesNo(question: string, defaultValue: boolean): boolean {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = ask(question, defaultValue ? "y" : "n").toLowerCase();
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    printError("Please answer y or n.");
  }
  throw new Error(`No valid answer provided for: ${question}`);
}

function askInt(question: string, defaultValue: number): number {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const value = parseInt(ask(question, String(defaultValue)), 10);
    if (!isNaN(value)) {
      return value;
    }
    printError("Entered value must be an integer.");
  }
  throw new Error(`No valid answer provided for: ${question}`);
}

/**
 * Credentials Q&A for a non-BigQuery warehouse; returns the .df-credentials.json contents.
 * Defaults mirror the non-interactive templates in init.ts (Supabase = Session pooler shape).
 */
function collectCredentials(warehouse: string): string {
  if (warehouse === "mysql") {
    const creds = {
      host: ask(CREDS_HOST_QUESTION, "localhost"),
      port: askInt(CREDS_PORT_QUESTION, 3306),
      database: ask(CREDS_DATABASE_QUESTION, "sqlanvil"),
      user: ask(CREDS_USER_QUESTION, "root"),
      password: interactivePasswordQuestion(CREDS_PASSWORD_QUESTION),
      sslMode: ask(CREDS_SSLMODE_QUESTION, "disable")
    };
    return `${JSON.stringify(creds, null, 2)}\n`;
  }
  const isSupabase = warehouse === "supabase";
  if (isSupabase) {
    print(SUPABASE_POOLER_HINT);
  }
  const host = ask(
    CREDS_HOST_QUESTION,
    isSupabase ? "aws-1-<region>.pooler.supabase.com" : "localhost"
  );
  if (/^db\..+\.supabase\.co$/.test(host)) {
    printError(
      "Warning: that is the DIRECT Supabase host, which is IPv6-only — connections fail with " +
        "ENOTFOUND on most networks. Prefer the Session pooler host (Dashboard -> Connect)."
    );
  }
  const creds = {
    host,
    port: askInt(CREDS_PORT_QUESTION, 5432),
    database: ask(CREDS_DATABASE_QUESTION, "postgres"),
    user: ask(CREDS_USER_QUESTION, isSupabase ? "postgres.<your-project-ref>" : "postgres"),
    password: interactivePasswordQuestion(CREDS_PASSWORD_QUESTION),
    sslMode: ask(CREDS_SSLMODE_QUESTION, isSupabase ? "require" : "disable"),
    defaultSchema: "public"
  };
  return `${JSON.stringify(creds, null, 2)}\n`;
}

/** One-line conversion summary + report location (shared with the migrate-dataform verb). */
export function printMigrationSummary(report: MigrationReport, outDir: string) {
  const targets = report.files.filter(f => f.action === "target");
  const flagged = targets.filter(f => f.status === "flagged").length;
  printSuccess(
    `Converted ${report.inventory.sqlxFiles} .sqlx file(s): ` +
      `${report.connections.length} source connection(s) over ` +
      `${report.files.filter(f => f.action === "declaration").length} declaration(s); ` +
      `${targets.length} target file(s), ${flagged} flagged for dialect review.`
  );
  print(`Report: ${path.join(outDir, "migration-report.md")}`);
}

function ensureGitignoreCoversCredentials(dir: string) {
  const gitignorePath = path.join(dir, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(".df-credentials")) {
    return;
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(gitignorePath, `${existing}${separator}.df-credentials*.json\n`);
}

/**
 * Is a usable Application Default Credential present? Uses gcloud's own check so the answer
 * matches what the BigQuery client will find. Deterministic (false) under the test harness —
 * tests drive the prompts, not the environment.
 */
function detectAdc(): boolean {
  if (process.env.DATAFORM_CLI_TEST_INPUTS !== undefined) {
    return false;
  }
  try {
    const result = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
      stdio: "ignore",
      timeout: 15000
    });
    return result.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * BigQuery auth step — BEFORE anything runs against the warehouse. Local sqlanvil runs
 * authenticate the same way Dataform local runs do: gcloud ADC by default, with a
 * service-account key as the explicit alternative. The ADC-mode credentials file
 * ({projectId, location}) holds no secrets and is written by the converter/init already.
 */
function runBigQueryAuthStep(projectDir: string) {
  const mode = askChoice(BQ_AUTH_QUESTION, ["adc", "key", "later"], "adc");

  if (mode === "adc") {
    if (detectAdc()) {
      printSuccess(
        "Application Default Credentials detected — runs authenticate as your gcloud account."
      );
      return;
    }
    if (askYesNo(BQ_AUTH_LOGIN_QUESTION, true)) {
      // Hand the terminal to gcloud (browser flow); fall through to guidance either way.
      spawnSync("gcloud", ["auth", "application-default", "login"], { stdio: "inherit" });
      if (detectAdc()) {
        printSuccess("ADC configured — runs authenticate as your gcloud account.");
        return;
      }
    }
    print(
      "Run `gcloud auth application-default login` before `sqlanvil validate` / `run` — no " +
        "other credential setup is needed."
    );
    return;
  }

  if (mode === "key") {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const keyPath = actuallyResolve(askRequired(BQ_KEY_PATH_QUESTION));
      if (!fs.existsSync(keyPath)) {
        printError(`${keyPath} does not exist.`);
        continue;
      }
      try {
        const keyContents = fs.readFileSync(keyPath, "utf8");
        const parsed = JSON.parse(keyContents) as { client_email?: string };
        if (!parsed.client_email) {
          printError(`${keyPath} does not look like a service-account key (no client_email).`);
          continue;
        }
        const credentialsPath = path.join(projectDir, CREDENTIALS_FILENAME);
        const existing = fs.existsSync(credentialsPath)
          ? (JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<string, string>)
          : {};
        ensureGitignoreCoversCredentials(projectDir);
        fs.writeFileSync(
          credentialsPath,
          `${JSON.stringify({ ...existing, credentials: keyContents }, null, 2)}\n`
        );
        printSuccess(
          `Runs authenticate as ${parsed.client_email} (key embedded in the gitignored ` +
            `${CREDENTIALS_FILENAME}).`
        );
        return;
      } catch (e) {
        printError(`Could not read ${keyPath}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }

  print(
    "Skipped. Before `sqlanvil validate` / `run`: `gcloud auth application-default login`, or " +
      `add a service-account key as the \`credentials\` field of ${CREDENTIALS_FILENAME}.`
  );
}

/**
 * Test-isolation step: make the FIRST real runs land somewhere safe — a `_<suffix>` dataset
 * suffix in the same project, or a separate GCP project — via the scaffolded `test`
 * environment in workflow_settings.yaml. Production datasets stay untouched until the user
 * deliberately runs without `--environment test`.
 */
function runBigQueryTestTargetStep(projectDir: string) {
  const choice = askChoice(BQ_TEST_TARGET_QUESTION, ["suffix", "project", "none"], "suffix");
  const settingsPath = path.join(projectDir, "workflow_settings.yaml");
  const settings = (loadYaml(fs.readFileSync(settingsPath, "utf8")) || {}) as Record<string, any>;

  if (choice === "none") {
    if (settings.environments?.test) {
      delete settings.environments.test;
      if (Object.keys(settings.environments).length === 0) {
        delete settings.environments;
      }
      fs.writeFileSync(settingsPath, dumpYaml(settings));
    }
    print("No test environment — runs go straight to the configured datasets.");
    return;
  }

  const testEnv: Record<string, string> = {};
  if (choice === "suffix") {
    testEnv.schemaSuffix = ask(BQ_TEST_SUFFIX_QUESTION, "test");
  } else {
    testEnv.defaultDatabase = askRequired(BQ_TEST_PROJECT_QUESTION);
  }
  settings.environments = { ...(settings.environments || {}), test: testEnv };
  fs.writeFileSync(settingsPath, dumpYaml(settings));
  printSuccess(
    choice === "suffix"
      ? `Test runs write to \`<dataset>_${testEnv.schemaSuffix}\` datasets ` +
          `(sqlanvil run . --environment test).`
      : `Test runs land in project ${testEnv.defaultDatabase} (sqlanvil run . --environment test).`
  );
}

async function runConvertFlow(): Promise<number> {
  let srcDir = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = actuallyResolve(askRequired(CONVERT_SOURCE_QUESTION));
    if (fs.existsSync(candidate)) {
      srcDir = candidate;
      break;
    }
    printError(`${candidate} does not exist.`);
  }
  if (!srcDir) {
    throw new Error("No usable source directory provided.");
  }
  const outDir = actuallyResolve(askRequired(CONVERT_OUT_QUESTION));
  // Dataform projects are BigQuery projects, so keep-BigQuery (tooling swap) is the default;
  // choosing supabase/postgres moves the warehouse (connections + dialect pass).
  const targetWarehouse = askChoice(
    CONVERT_TARGET_QUESTION,
    ["bigquery", "supabase", "postgres"],
    "bigquery"
  ) as "bigquery" | "supabase" | "postgres";

  print("\nConverting...\n");
  const report = await migrateDataform({ srcDir, outDir, targetWarehouse });
  printMigrationSummary(report, outDir);

  if (targetWarehouse === "bigquery") {
    // Same warehouse. BEFORE anything touches BigQuery: how runs authenticate (ADC like
    // Dataform local runs, or a key), and where TEST runs land so production datasets stay
    // untouched until everything is verified.
    print("");
    runBigQueryAuthStep(outDir);
    print("");
    runBigQueryTestTargetStep(outDir);

    const hasTestEnv = fs.existsSync(path.join(outDir, "workflow_settings.yaml"))
      ? !!((loadYaml(
          fs.readFileSync(path.join(outDir, "workflow_settings.yaml"), "utf8")
        ) || {}) as Record<string, any>).environments?.test
      : false;
    print("\nNext steps:");
    print(`  1. sqlanvil compile ${outDir}`);
    print(
      `  2. sqlanvil validate ${outDir}  (read-only dry-run of every model; all-PASS = swap complete)`
    );
    if (hasTestEnv) {
      print(
        `  3. sqlanvil run ${outDir} --environment test  (first real run — production untouched)`
      );
      print(`  4. sqlanvil run ${outDir}  (once the test run is verified)`);
    } else {
      print(`  3. sqlanvil run ${outDir}`);
    }
    return 0;
  }

  // Moving to Supabase/Postgres: offer to wire credentials right away.
  if (askYesNo(INIT_CONFIGURE_CREDS_QUESTION, true)) {
    const credentialsPath = path.join(outDir, CREDENTIALS_FILENAME);
    ensureGitignoreCoversCredentials(outDir);
    fs.writeFileSync(credentialsPath, collectCredentials(targetWarehouse));
    printSuccess(`Credentials written to ${credentialsPath}`);
  }

  print("\nNext steps:");
  print(`  1. sqlanvil compile ${outDir}`);
  print(
    `  2. Review ${path.join(outDir, "migration-report.md")} — BigQuery source connections ` +
      `need columnTypes (the introspect commands are in the report).`
  );
  print(
    `  3. sqlanvil validate ${outDir}  (PASS/FAILURE/BLOCKED per model = the migration to-do list)`
  );
  return 0;
}

async function runFreshFlow(defaultProjectDir: string): Promise<number> {
  const warehouse = askChoice(
    INIT_WAREHOUSE_QUESTION,
    ["supabase", "postgres", "bigquery", "mysql"],
    "supabase"
  );
  const isPostgresLike = warehouse === "postgres" || warehouse === "supabase";
  const projectDir = actuallyResolve(ask(INIT_PROJECT_DIR_QUESTION, defaultProjectDir));

  const projectConfig: sqlanvil.IProjectConfig = { warehouse };
  if (warehouse === "bigquery") {
    projectConfig.defaultDatabase = askRequired(INIT_BQ_PROJECT_QUESTION);
    projectConfig.defaultLocation = askRequired(INIT_BQ_LOCATION_QUESTION);
  }
  projectConfig.defaultSchema = ask(
    INIT_DEFAULT_SCHEMA_QUESTION,
    isPostgresLike ? "public" : "sqlanvil"
  );

  const includeSample = askYesNo(INIT_INCLUDE_SAMPLE_QUESTION, true);
  const includeBigQuerySource =
    includeSample && isPostgresLike ? askYesNo(INIT_INCLUDE_BQ_SOURCE_QUESTION, true) : undefined;

  let credentialsJson: string | undefined;
  if (warehouse !== "bigquery" && askYesNo(INIT_CONFIGURE_CREDS_QUESTION, true)) {
    credentialsJson = collectCredentials(warehouse);
  }

  print("\nWriting project files...\n");
  const result = await init(projectDir, projectConfig, {
    includeSample,
    includeBigQuerySource,
    credentialsJson
  });
  printInitResult(result);

  if (warehouse === "bigquery") {
    // Secretless ADC-mode credentials file (project + location only) + the auth step —
    // BEFORE the next-steps suggest running anything.
    const credentialsPath = path.join(projectDir, CREDENTIALS_FILENAME);
    if (!fs.existsSync(credentialsPath)) {
      ensureGitignoreCoversCredentials(projectDir);
      fs.writeFileSync(
        credentialsPath,
        `${JSON.stringify(
          {
            projectId: projectConfig.defaultDatabase,
            ...(projectConfig.defaultLocation ? { location: projectConfig.defaultLocation } : {})
          },
          null,
          2
        )}\n`
      );
    }
    print("");
    runBigQueryAuthStep(projectDir);
  }

  const steps: string[] = [];
  if (warehouse === "bigquery") {
    // Auth handled above (ADC by default) — no separate credentials step.
  } else if (!credentialsJson) {
    steps.push(`Edit ${CREDENTIALS_FILENAME} (gitignored) with your warehouse credentials.`);
  }
  if (includeSample) {
    steps.push(
      "Point definitions/sources/app_orders.sqlx at a real table in your warehouse."
    );
  }
  if (isPostgresLike && includeBigQuerySource) {
    steps.push(
      "Replace REPLACE_WITH_YOUR_GCP_PROJECT in workflow_settings.yaml (billingProject for " +
        "the BigQuery sample source)."
    );
  }
  steps.push(`sqlanvil compile ${projectDir}`);
  steps.push(
    `sqlanvil validate ${projectDir}  (checks every model against the warehouse without executing)`
  );
  print("\nNext steps:");
  steps.forEach((step, index) => print(`  ${index + 1}. ${step}`));
  return 0;
}

/**
 * `sqlanvil init --interactive` — the CLI twin of the Cloud new-project wizard: a Q&A over
 * the init scaffolder (fresh path) and the migrate-dataform converter (convert path).
 * Explicit flag only; the non-interactive `init` is unchanged for scripts/CI.
 */
export async function runInteractiveInit(defaultProjectDir: string): Promise<number> {
  // readline-sync needs a real terminal; fail fast with guidance instead of its raw
  // "doesn't support interactive reading from TTY" stack (test inputs bypass the TTY).
  if (!process.stdin.isTTY && process.env.DATAFORM_CLI_TEST_INPUTS === undefined) {
    printError(
      "init --interactive needs an interactive terminal (stdin is not a TTY). " +
        "Use the non-interactive form instead: sqlanvil init [project-dir] --warehouse=... " +
        '(see "sqlanvil help init").'
    );
    return 1;
  }
  const mode = askChoice(INIT_MODE_QUESTION, ["fresh", "convert"], "fresh");
  if (mode === "convert") {
    return runConvertFlow();
  }
  return runFreshFlow(defaultProjectDir);
}
