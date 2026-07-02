import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
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
// Postgres allows at most 65535 bind params per statement; keep batches well under that.
const MAX_PARAMS_PER_INSERT = 60000;

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

const quoteIdent = (id: string) => `"${String(id).replace(/"/g, '""')}"`;

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
    throw new Error(`runner-extract supports only bigquery sources (got "${spec.platform}").`);
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
  const pg = await PostgresDbAdapter.create(args.pg, {
    disableSslForTestsOnly: args.disableSslForTestsOnly
  });
  try {
    const qualified = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
    const colDefs = cols.map(c => `${quoteIdent(c)} ${spec.columnTypes[c]}`).join(", ");
    await pg.execute(`create schema if not exists ${quoteIdent(target.schema)}`);
    // Drop a same-named FOREIGN table too (cascade), so switching a warehouse from `fdw` to
    // `runner-extract` — or re-running — doesn't collide: `drop table` won't remove a foreign table,
    // and dependents (downstream views) are rebuilt by the rest of the run anyway.
    await pg.execute(`drop foreign table if exists ${qualified} cascade`);
    await pg.execute(`drop table if exists ${qualified} cascade`);
    await pg.execute(`create table ${qualified} (${colDefs})`);

    const colIdents = cols.map(quoteIdent).join(", ");
    const batchRows = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS_PER_INSERT / cols.length)));
    for (let i = 0; i < rows.length; i += batchRows) {
      const batch = rows.slice(i, i + batchRows);
      const params: any[] = [];
      const tuples = batch.map((row, r) => {
        const placeholders = cols.map((c, ci) => `$${r * cols.length + ci + 1}`);
        cols.forEach(c => params.push(coerce(row[c])));
        return `(${placeholders.join(", ")})`;
      });
      await pg.execute(`insert into ${qualified} (${colIdents}) values ${tuples.join(", ")}`, {
        params
      });
    }
    return { rowCount: rows.length };
  } finally {
    await pg.close();
  }
}
