import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

import { allAsync, runAsync, withDuckdb } from "sa/cli/api/dbadapters/duckdb";

/**
 * Parquet I/O for the queryable artifacts, via the bundled DuckDB (`@duckdb/node-api`).
 * Rows go out as Parquet (rows → temp JSON → DuckDB COPY); `queryParquet` runs arbitrary SQL over
 * a set of Parquet globs exposed as views.
 */

let tmpCounter = 0;

/**
 * Write `rows` to a Parquet file at `outPath`. `columns` is the full ordered column list — used to
 * produce a correctly-typed 0-row Parquet when `rows` is empty (so downstream `SELECT *` still
 * works). Parent directories are created.
 */
export async function writeParquet(
  rows: object[],
  outPath: string,
  columns: string[]
): Promise<void> {
  await fs.ensureDir(path.dirname(outPath));
  const tmp = path.join(os.tmpdir(), `sa_artifact_${process.pid}_${Date.now()}_${tmpCounter++}.json`);
  // For an empty rowset, emit one all-null row and filter it out, so the Parquet keeps its columns.
  const payload =
    rows.length > 0 ? rows : [columns.reduce((o: any, c) => ((o[c] = null), o), {})];
  const whereFalse = rows.length > 0 ? "" : " WHERE false";
  await fs.writeFile(tmp, JSON.stringify(payload));
  try {
    await withDuckdb(async conn => {
      await runAsync(
        conn,
        `COPY (SELECT * FROM read_json_auto('${tmp}')${whereFalse}) TO '${outPath}' (FORMAT parquet)`
      );
    });
  } finally {
    await fs.remove(tmp).catch(() => undefined);
  }
}

export interface ArtifactView {
  name: string;
  /** A Parquet file path or glob, e.g. `target/catalog/actions.parquet` or `target/runs/*.parquet`. */
  glob: string;
}

/**
 * Run `sql` over the given Parquet `views` (each exposed via `read_parquet`). Only pass views whose
 * files exist — a `read_parquet` over a non-matching glob errors at view creation.
 */
// DuckDB returns int64 aggregates (count(*), sum(...)) as BigInt, which JSON.stringify
// rejects — normalize to Number when safe, decimal string otherwise.
const normalizeValue = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString()
    : v;

export async function queryParquet(sql: string, views: ArtifactView[]): Promise<any[]> {
  return withDuckdb(async conn => {
    for (const view of views) {
      await runAsync(conn, `create view ${view.name} as select * from read_parquet('${view.glob}')`);
    }
    const rows = await allAsync(conn, sql);
    return rows.map((row: any) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(v)]))
    );
  });
}
