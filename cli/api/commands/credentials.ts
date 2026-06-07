import * as fs from "fs";

import * as dbadapters from "sa/cli/api/dbadapters";
import { verifyObjectMatchesProto } from "sa/common/protos";
import { sqlanvil } from "sa/protos/ts";

export const CREDENTIALS_FILENAME = ".df-credentials.json";

export function read(credentialsPath: string, warehouse: string = "bigquery"): any {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Missing credentials JSON file; not found at path '${credentialsPath}'.`);
  }
  let credentialsAsJson: { [key: string]: any };
  try {
    credentialsAsJson = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch (e) {
    throw new Error(`Error reading credentials file: ${e.message}`);
  }
  // `connections` holds read-only source-connection credentials consumed by
  // `sqlanvil introspect` (keyed by connection name, mirroring the `connections:`
  // map in workflow_settings.yaml). It is not part of the write-warehouse
  // connection, so exclude it from the strict warehouse-credentials validation.
  const { connections, ...warehouseCredentials } = credentialsAsJson;
  const isPostgres = warehouse.toLowerCase() === "postgres" || warehouse.toLowerCase() === "supabase";
  if (isPostgres) {
    const credentials = verifyObjectMatchesProto(sqlanvil.PostgresConnection, warehouseCredentials);
    if (!credentials.host) {
      throw new Error(`Error reading credentials file: the host field is required`);
    }
    return credentials;
  } else {
    const credentials = verifyObjectMatchesProto(sqlanvil.BigQuery, warehouseCredentials);
    if (!Object.keys(credentials).find(key => key === "projectId")?.length) {
      throw new Error(`Error reading credentials file: the projectId field is required`);
    }
    return credentials;
  }
}

export enum TestResultStatus {
  SUCCESSFUL,
  TIMED_OUT,
  OTHER_ERROR
}

export interface ITestResult {
  status: TestResultStatus;
  error?: Error;
}

export async function test(
  dbadapter: dbadapters.IDbAdapter,
  timeoutMs: number = 10000
): Promise<ITestResult> {
  let timer;
  try {
    const timeout = new Promise<TestResultStatus>(
      resolve => (timer = setTimeout(() => resolve(TestResultStatus.TIMED_OUT), timeoutMs))
    );
    const executeQuery = dbadapter.execute("SELECT 1 AS x").then(() => TestResultStatus.SUCCESSFUL);
    return {
      status: await Promise.race([executeQuery, timeout])
    };
  } catch (e) {
    return {
      status: TestResultStatus.OTHER_ERROR,
      error: e
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
