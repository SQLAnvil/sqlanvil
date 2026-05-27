// tslint:disable tsr-detect-non-literal-fs-filename
import * as path from "path";

export const DEFAULT_DATABASE = "your-bigquery-project";
export const DEFAULT_LOCATION = "US";
export const DEFAULT_RESERVATION = "projects/your-bigquery-project/locations/us/reservations/sqlanvil-test";
export const CREDENTIALS_PATH = path.resolve(process.env.RUNFILES, "sa/test_credentials/bigquery.json");

export const cliEntryPointPath = "cli/node_modules/@sqlanvil/cli/bundle.js";
