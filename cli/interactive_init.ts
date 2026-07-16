import * as fs from "fs";
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
    // Same warehouse — credentials come from gcloud ADC or a service-account key, not the
    // Postgres credentials Q&A.
    print("\nNext steps:");
    print(`  1. sqlanvil compile ${outDir}`);
    print(
      "  2. Credentials: gcloud auth application-default login (ADC), or a service-account " +
        `key in a gitignored ${CREDENTIALS_FILENAME}.`
    );
    print(
      `  3. sqlanvil validate ${outDir}  (dry-runs every model against BigQuery; all-PASS = swap complete)`
    );
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

  const steps: string[] = [];
  if (warehouse === "bigquery") {
    steps.push(`sqlanvil init-creds ${projectDir}  (BigQuery credentials)`);
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
