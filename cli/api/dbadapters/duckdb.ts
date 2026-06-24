import * as os from "os";

import { nativeRequire } from "sa/core/utils";

/**
 * Shared helpers for the bundled DuckDB (`@duckdb/node-api`) — used by both runner-side exports
 * (`duckdb_export.ts`) and the queryable artifacts (`duckdb_artifacts.ts`).
 */

/** Lazily load the optional DuckDB binding via the real (non-webpack) require. */
export function loadDuckdb(): any {
  try {
    return nativeRequire("@duckdb/node-api");
  } catch (e) {
    throw new Error(
      `This feature requires the optional "@duckdb/node-api" dependency, which failed to load: ` +
        `${e.message}`
    );
  }
}

/** Run a statement (or `;`-separated statements); the result, if any, is discarded. */
export async function runAsync(conn: any, sql: string): Promise<void> {
  await conn.run(sql);
}

/** Run a query and return its rows as plain objects. */
export async function allAsync(conn: any, sql: string): Promise<any[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects();
}

/**
 * Open a DuckDB connection (in-memory by default, or a file path), run `fn`, and always close.
 * When `$HOME` is unset (sandboxed/minimal envs) the extension cache dir is redirected so INSTALL
 * works.
 */
export async function withDuckdb<T>(
  fn: (conn: any) => Promise<T>,
  dbPath: string = ":memory:"
): Promise<T> {
  const { DuckDBInstance } = loadDuckdb();
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const done = () => {
    try {
      conn.closeSync?.();
    } catch (e) {
      /* ignore */
    }
    try {
      instance.closeSync?.();
    } catch (e) {
      /* ignore */
    }
  };
  try {
    if (!process.env.HOME) {
      await runAsync(conn, `SET home_directory='${os.tmpdir()}'`);
    }
    const result = await fn(conn);
    done();
    return result;
  } catch (e) {
    done();
    throw e;
  }
}
