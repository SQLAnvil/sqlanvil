import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { loadRowsIntoPostgres } from "sa/cli/api/dbadapters/extract_load";
import { sqlanvil } from "sa/protos/ts";

/**
 * runner-extract loader: read a cross-warehouse source (keyless BigQuery) and materialize the rows
 * into a plain Postgres/Supabase table. The keyless path for a `connection: { mode: "runner-extract" }`
 * declaration — replaces the live FDW foreign table, so it needs no Vault secret and no
 * `wrappers`/`postgis` on the branch. Auth for the source rides in .df-credentials.json's `connections`
 * map (a brokered `accessToken`, a key JSON, or ADC).
 */

// Guard rails (D5): cap the extract so a huge source can't blow up a branch. Truncation is logged.
const DEFAULT_ROW_CAP = 1_000_000;
const DEFAULT_BYTE_CAP = 512 * 1024 * 1024;

export interface BigQueryExtractArgs {
  spec: sqlanvil.IExtractSpec;
  target: sqlanvil.ITarget;
  /** The write-warehouse (Postgres/Supabase) connection to materialize into. */
  pg: sqlanvil.IPostgresConnection;
  /** .df-credentials.json `connections` map — source auth keyed by connection name. */
  connectionCredentials: { [name: string]: any };
  rowCap?: number;
  byteCap?: number;
  /** Test-only: skip real SSL negotiation against a local Postgres. */
  disableSslForTestsOnly?: boolean;
}

/** BigQuery wraps DATE/TIME/TIMESTAMP/NUMERIC as `{ value: "..." }`; unwrap to a primitive for pg. */
function coerce(v: any): any {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === "object" && v !== null && "value" in v) {
    return (v as { value: unknown }).value;
  }
  return v;
}

export async function runBigQueryExtract(args: BigQueryExtractArgs): Promise<{ rowCount: number }> {
  const { spec, target, connectionCredentials } = args;
  if ((spec.platform || "bigquery") !== "bigquery") {
    throw new Error(`bigquery runner-extract got a "${spec.platform}" source.`);
  }
  const cols = Object.keys(spec.columnTypes || {});
  if (cols.length === 0) {
    throw new Error(
      `Extract "${target.schema}.${target.name}" has no columnTypes; run \`sqlanvil introspect\`.`
    );
  }
  if (!args.pg) {
    throw new Error("runner-extract needs the write-warehouse connection (warehouseConnection).");
  }

  // Read the source, keyless: billed to `billingProject` (falls back to the source project), read via
  // the full FQN so a read-but-not-bill dataset (e.g. bigquery-public-data) still works.
  const conn = connectionCredentials?.[spec.connectionName] || {};
  const bq = new BigQueryDbAdapter(
    sqlanvil.BigQuery.create({
      projectId: spec.billingProject || spec.project,
      location: conn.location,
      accessToken: conn.accessToken,
      credentials: conn.credentials
    })
  );
  const rowCap = args.rowCap ?? DEFAULT_ROW_CAP;
  const byteCap = args.byteCap ?? DEFAULT_BYTE_CAP;
  const colList = cols.map(c => "`" + c + "`").join(", ");
  const fqn = "`" + `${spec.project}.${spec.dataset}.${spec.sourceName}` + "`";
  const { rows } = await bq.execute(`select ${colList} from ${fqn}`, {
    rowLimit: rowCap,
    byteLimit: byteCap
  });
  if (rows.length >= rowCap) {
    // eslint-disable-next-line no-console
    console.warn(
      `runner-extract: ${target.schema}.${target.name} truncated at ${rowCap} rows (source is larger).`
    );
  }

  // Materialize into the warehouse.
  await loadRowsIntoPostgres({
    pg: args.pg,
    target,
    columnTypes: spec.columnTypes,
    rows,
    coerce,
    disableSslForTestsOnly: args.disableSslForTestsOnly
  });
  return { rowCount: rows.length };
}
