// tslint:disable tsr-detect-non-literal-fs-filename
import * as path from "path";

// BigQuery integration test settings. Read from env vars so the project ID
// isn't committed to source. CI sets these from secrets; locally, contributors
// can set them in their shell or a sourced .envrc.
//
// See docs/gcp_test_project_setup.md for setting up the test project + creds.

export const DEFAULT_DATABASE =
  process.env.SQLANVIL_TEST_BQ_PROJECT || "your-bigquery-project";
export const DEFAULT_LOCATION = process.env.SQLANVIL_TEST_BQ_LOCATION || "US";
// Reservation is optional — most contributors don't have one. Empty string
// means "use BigQuery on-demand pricing" which fits comfortably in the free
// tier for test workloads.
export const DEFAULT_RESERVATION = process.env.SQLANVIL_TEST_BQ_RESERVATION || "";
export const CREDENTIALS_PATH = path.resolve(process.env.RUNFILES, "sa/test_credentials/bigquery.json");

export const cliEntryPointPath = "cli/node_modules/@sqlanvil/cli/bundle.js";
