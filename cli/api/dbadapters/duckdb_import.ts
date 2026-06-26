import { runAsync, withDuckdb } from "sa/cli/api/dbadapters/duckdb";
import {
  buildAttachSql,
  buildSecretSql,
  PG_ATTACH_ALIAS,
  schemeOf,
  toCopyTarget
} from "sa/cli/api/dbadapters/duckdb_export";
import { sqlanvil } from "sa/protos/ts";

/**
 * Pure SQL builders for the runner-side DuckDB import (Postgres/Supabase) — the inverse of the
 * export bridge.
 *
 * The import runs entirely in DuckDB: ATTACH the Postgres database **read-write**, (optionally)
 * CREATE SECRET for the object-store source, then read the file via `read_parquet`/`read_csv_auto`/
 * `read_json_auto` and write the rows into the warehouse table through the attached connection
 * (`CREATE TABLE pg."s"."t" AS SELECT …` to replace, or `INSERT INTO …` to append). DuckDB does the
 * file decoding; the table lands in Postgres so downstream models can `ref()` it.
 */

/** Maps an import format to the DuckDB reader function. */
export function readerForFormat(format: string): string {
  switch ((format || "").toLowerCase()) {
    case "csv":
      return "read_csv_auto";
    case "json":
      return "read_json_auto";
    case "parquet":
    default:
      return "read_parquet";
  }
}

/** The destination table addressed through the Postgres ATTACH alias (double-quoted identifiers). */
export function importTargetSql(target: sqlanvil.ITarget): string {
  return target.schema
    ? `${PG_ATTACH_ALIAS}."${target.schema}"."${target.name}"`
    : `${PG_ATTACH_ALIAS}."${target.name}"`;
}

/**
 * Builds the DuckDB statement(s) that load `location` into the warehouse table. `overwrite` (the
 * default) replaces the table (drop + create-as-select); otherwise rows are appended (the table
 * must already exist).
 */
export function buildImportSql(
  target: sqlanvil.ITarget,
  location: string,
  format: string,
  overwrite: boolean
): string[] {
  const reader = readerForFormat(format);
  const source = toCopyTarget(location);
  const dest = importTargetSql(target);
  const select = `SELECT * FROM ${reader}('${source}')`;
  if (overwrite) {
    return [`DROP TABLE IF EXISTS ${dest}`, `CREATE TABLE ${dest} AS ${select}`];
  }
  return [`INSERT INTO ${dest} ${select}`];
}

export interface DuckdbImportArgs {
  spec: sqlanvil.IImportSpec;
  target: sqlanvil.ITarget;
  pg: sqlanvil.IPostgresConnection;
  storage?: { [scheme: string]: { [key: string]: string } };
}

/**
 * Runs a Postgres/Supabase import via DuckDB: ATTACH the database read-write, configure the
 * object-store secret (non-local), then read the source file and write it into the warehouse table.
 */
export async function runDuckdbImport(args: DuckdbImportArgs): Promise<{ source: string }> {
  const { spec, target, pg, storage } = args;
  const location = spec.location || "";
  const scheme = schemeOf(location);
  if (scheme !== "local" && !storage?.[scheme]) {
    throw new Error(
      `No "${scheme}" storage credentials found in .df-credentials.json (storage.${scheme}) for ` +
        `import from ${location}.`
    );
  }
  return withDuckdb(async conn => {
    await runAsync(conn, "INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;");
    await runAsync(conn, buildAttachSql(pg, { readOnly: false }));
    if (scheme !== "local") {
      const secret = buildSecretSql(scheme, storage[scheme]);
      if (secret) {
        await runAsync(conn, secret);
      }
    }
    for (const statement of buildImportSql(target, location, spec.format, spec.overwrite)) {
      await runAsync(conn, statement);
    }
    return { source: toCopyTarget(location) };
  });
}
