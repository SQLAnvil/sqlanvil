import { allAsync, runAsync, withDuckdb } from "sa/cli/api/dbadapters/duckdb";
import { resolveExportUri } from "sa/cli/api/dbadapters/export_uri";
import { sqlanvil } from "sa/protos/ts";

/**
 * Pure SQL builders for the runner-side DuckDB export (Postgres/Supabase).
 *
 * The export runs entirely in DuckDB: ATTACH the Postgres database read-only,
 * (optionally) CREATE SECRET for the object-store target, then COPY the result of
 * `postgres_query('pg', <SELECT>)` to the destination URI. Running the SELECT
 * through `postgres_query` means it executes verbatim on Postgres (correct
 * dialect, refs already resolved) — DuckDB only encodes + uploads.
 */

export const PG_ATTACH_ALIAS = "pg";
export const SECRET_NAME = "sa_export";

/** Builds the DuckDB ATTACH for the project's Postgres connection (read-only). */
export function buildAttachSql(pg: sqlanvil.IPostgresConnection): string {
  const dsn = [
    pg.host && `host=${pg.host}`,
    pg.port && `port=${pg.port}`,
    pg.database && `dbname=${pg.database}`,
    pg.user && `user=${pg.user}`,
    pg.password && `password=${pg.password}`
  ]
    .filter(Boolean)
    .join(" ");
  return `ATTACH '${dsn}' AS ${PG_ATTACH_ALIAS} (TYPE postgres, READ_ONLY)`;
}

/**
 * Builds a DuckDB CREATE SECRET for the object-store scheme, or `null` for a
 * scheme that needs no secret (local). For S3-compatible endpoints (e.g. Supabase
 * Storage) the `endpoint` triggers path-style addressing over SSL.
 */
export function buildSecretSql(
  scheme: string,
  creds: { [key: string]: string }
): string | null {
  if (scheme === "s3") {
    const fields = [
      "TYPE s3",
      creds.accessKeyId && `KEY_ID '${creds.accessKeyId}'`,
      creds.secretAccessKey && `SECRET '${creds.secretAccessKey}'`,
      creds.region && `REGION '${creds.region}'`,
      creds.endpoint && `ENDPOINT '${creds.endpoint}'`,
      creds.endpoint && `URL_STYLE 'path'`,
      creds.endpoint && `USE_SSL true`
    ]
      .filter(Boolean)
      .join(", ");
    return `CREATE OR REPLACE SECRET ${SECRET_NAME} (${fields})`;
  }
  if (scheme === "gcs") {
    const fields = [
      "TYPE gcs",
      creds.keyId && `KEY_ID '${creds.keyId}'`,
      creds.secret && `SECRET '${creds.secret}'`
    ]
      .filter(Boolean)
      .join(", ");
    return `CREATE OR REPLACE SECRET ${SECRET_NAME} (${fields})`;
  }
  return null;
}

/** Maps a `location` URI to the path DuckDB COPY writes to. */
export function toCopyTarget(uri: string): string {
  if (uri.startsWith("local://")) {
    return uri.slice("local://".length);
  }
  return uri;
}

/** Returns the storage scheme of a URI: "s3" | "gcs" | "local". */
export function schemeOf(uri: string): "s3" | "gcs" | "local" {
  if (uri.startsWith("s3://")) {
    return "s3";
  }
  if (uri.startsWith("gs://") || uri.startsWith("gcs://")) {
    return "gcs";
  }
  return "local";
}

/**
 * Builds the DuckDB COPY that exports the Postgres SELECT to the destination.
 * Format-specific `options` are appended as `KEY value` pairs (DuckDB COPY
 * option syntax); values must be DuckDB-valid (e.g. `{ COMPRESSION: "'zstd'" }`).
 */
export function buildCopySql(
  selectSql: string,
  uri: string,
  format: string,
  options: { [key: string]: string } = {}
): string {
  const target = toCopyTarget(uri);
  const fmt = (format || "").toLowerCase();
  const extraOptions = Object.entries(options || {}).map(
    ([key, value]) => `${key.toUpperCase()} ${value}`
  );
  const optionList = [`FORMAT ${fmt}`, ...extraOptions].join(", ");
  return `COPY (SELECT * FROM postgres_query('${PG_ATTACH_ALIAS}', $sa$${selectSql}$sa$)) TO '${target}' (${optionList})`;
}

// Execution helpers (loadDuckdb / runAsync / allAsync / withDuckdb) live in
// `sa/cli/api/dbadapters/duckdb` and are shared with the queryable-artifacts writer.

export interface DuckdbExportArgs {
  spec: sqlanvil.IExportSpec;
  selectSql: string;
  pg: sqlanvil.IPostgresConnection;
  storage?: { [scheme: string]: { [key: string]: string } };
  actionName: string;
}

/**
 * Runs a Postgres/Supabase export via DuckDB: ATTACH the database read-only,
 * configure the object-store secret (non-local), then COPY the result of the
 * SELECT (run on Postgres via `postgres_query`) to the destination.
 */
export async function runDuckdbExport(args: DuckdbExportArgs): Promise<{ destination: string }> {
  const { spec, selectSql, pg, storage, actionName } = args;
  const uri = resolveExportUri(spec, actionName, { wildcard: false });
  const scheme = schemeOf(uri);
  if (scheme !== "local" && !storage?.[scheme]) {
    throw new Error(
      `No "${scheme}" storage credentials found in .df-credentials.json (storage.${scheme}) for ` +
        `export to ${uri}.`
    );
  }
  return withDuckdb(async conn => {
    await runAsync(conn, "INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;");
    await runAsync(conn, buildAttachSql(pg));
    if (scheme !== "local") {
      const secret = buildSecretSql(scheme, storage[scheme]);
      if (secret) {
        await runAsync(conn, secret);
      }
    }
    await runAsync(conn, buildCopySql(selectSql, uri, spec.format, spec.options || {}));
    return { destination: toCopyTarget(uri) };
  });
}

/**
 * Exports a direct DuckDB SELECT (no Postgres attach) to a local/object-store
 * URI. Used by tests and as a lightweight path; the SELECT runs in DuckDB itself.
 */
export async function writeViaDuckdb(
  selectSql: string,
  uri: string,
  format: string
): Promise<void> {
  await withDuckdb(async conn => {
    await runAsync(
      conn,
      `COPY (${selectSql}) TO '${toCopyTarget(uri)}' (FORMAT ${(format || "").toLowerCase()})`
    );
    return undefined;
  });
}

/** Reads a previously written file back through DuckDB (used by tests). */
export async function readViaDuckdb(uri: string, format: string): Promise<any[]> {
  const reader =
    format === "parquet"
      ? "read_parquet"
      : format === "csv"
      ? "read_csv_auto"
      : "read_json_auto";
  return withDuckdb(conn => allAsync(conn, `SELECT * FROM ${reader}('${toCopyTarget(uri)}')`));
}
