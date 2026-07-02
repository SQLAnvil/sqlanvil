// tslint:disable tsr-detect-non-literal-fs-filename
import * as fs from "fs";
import * as path from "path";

const runfilesDir = process.env.RUNFILES;
let workspaceName = "sa";
if (!fs.existsSync(path.resolve(runfilesDir, "sa"))) {
  workspaceName = "_main";
}

export const CREDENTIALS_PATH = path.resolve(runfilesDir, workspaceName, "test_credentials/bigquery.json");

// The GCP project for live BigQuery CLI integration tests (used as the project
// arg when shelling out to `sqlanvil init`/`run`). Not hardcoded — this is OSS.
// Single source of truth: the same test_credentials/bigquery.json used for auth
// (its `projectId`), mirroring tests/integration/utils.ts. Override with
// SA_TEST_BIGQUERY_PROJECT if needed; falls back to a placeholder when no creds
// are present (the tests can't run without creds anyway).
function detectDefaultProject(): string {
  if (process.env.SA_TEST_BIGQUERY_PROJECT) {
    return process.env.SA_TEST_BIGQUERY_PROJECT;
  }
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    if (creds && (creds.projectId || creds.project_id)) {
      return creds.projectId || creds.project_id;
    }
  } catch (e) {
    // No creds available — fall through to the placeholder.
  }
  return "your-bigquery-project";
}

export const DEFAULT_DATABASE = detectDefaultProject();
export const DEFAULT_LOCATION = "US";
export const DEFAULT_RESERVATION = `projects/${DEFAULT_DATABASE}/locations/us/reservations/sqlanvil-test`;

export const cliEntryPointPath = "cli/node_modules/@sqlanvil/cli/bundle.js";
