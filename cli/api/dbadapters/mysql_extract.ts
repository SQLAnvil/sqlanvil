import { loadRowsIntoPostgres } from "sa/cli/api/dbadapters/extract_load";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { sqlanvil } from "sa/protos/ts";

/**
 * runner-extract loader for MySQL/MariaDB sources: read the source table over the wire and
 * materialize the rows into a plain Postgres/Supabase table. MySQL has no Postgres FDW, so
 * runner-extract is the ONLY source mode for it (core rejects `mode: "fdw"` at compile time).
 * Auth rides in .df-credentials.json's `connections` map: `{ host, port, user, password,
 * database?, sslMode? }` keyed by connection name; the non-secret host/port/database defaults
 * may also live on the workflow_settings connection (carried on the spec).
 */

// Guard rails, mirroring bigquery_extract: cap the extract so a huge source can't blow up a run.
// The row cap rides in the SQL itself (`limit cap+1`) so mysql2 — which buffers the full result
// set — never holds more than cap+1 rows.
const DEFAULT_ROW_CAP = 1_000_000;
const DEFAULT_BYTE_CAP = 512 * 1024 * 1024;

export interface MysqlExtractArgs {
  spec: sqlanvil.IExtractSpec;
  target: sqlanvil.ITarget;
  /** The write-warehouse (Postgres/Supabase) connection to materialize into. */
  pg: sqlanvil.IPostgresConnection;
  /** .df-credentials.json `connections` map — source auth keyed by connection name. */
  connectionCredentials: { [name: string]: any };
  rowCap?: number;
  byteCap?: number;
  /** Test-only: skip real SSL negotiation against local databases. */
  disableSslForTestsOnly?: boolean;
}

const backquote = (id: string) => "`" + String(id).replace(/`/g, "``") + "`";

export async function runMysqlExtract(args: MysqlExtractArgs): Promise<{ rowCount: number }> {
  const { spec, target, connectionCredentials } = args;
  if (spec.platform !== "mysql") {
    throw new Error(`mysql runner-extract got a "${spec.platform}" source.`);
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

  const conn = connectionCredentials?.[spec.connectionName] || {};
  // Declared source database (declaration `schema:` / connection `database:`) wins; the
  // credentials entry is the fallback for setups that keep it with the secret.
  const database = spec.database || conn.database;
  if (!database) {
    throw new Error(
      `Extract "${target.schema}.${target.name}": no source database — set \`database:\` on ` +
        `connection "${spec.connectionName}" (workflow_settings.yaml) or \`schema:\` on the declaration.`
    );
  }
  if (!conn.host && !conn.user) {
    throw new Error(
      `No credentials for connection "${spec.connectionName}" — add it to .df-credentials.json's ` +
        `"connections" map ({ host, port, user, password }).`
    );
  }

  const rowCap = args.rowCap ?? DEFAULT_ROW_CAP;
  const byteCap = args.byteCap ?? DEFAULT_BYTE_CAP;
  const my = await MySqlDbAdapter.create(
    sqlanvil.MysqlConnection.create({
      host: conn.host,
      port: conn.port || 3306,
      user: conn.user,
      password: conn.password,
      database,
      sslMode: conn.sslMode
    }),
    { disableSslForTestsOnly: args.disableSslForTestsOnly }
  );

  let rows: any[];
  try {
    const colList = cols.map(backquote).join(", ");
    const source = `${backquote(database)}.${backquote(spec.sourceName)}`;
    // `limit cap+1` bounds mysql2's buffering AND tells us whether the source was larger.
    ({ rows } = await my.execute(`select ${colList} from ${source} limit ${rowCap + 1}`, {
      rowLimit: rowCap + 1,
      byteLimit: byteCap
    }));
  } finally {
    await my.close().catch(() => undefined);
  }
  if (rows.length > rowCap) {
    rows = rows.slice(0, rowCap);
    // eslint-disable-next-line no-console
    console.warn(
      `runner-extract: ${target.schema}.${target.name} truncated at ${rowCap} rows (source is larger).`
    );
  }

  await loadRowsIntoPostgres({
    pg: args.pg,
    target,
    columnTypes: spec.columnTypes,
    rows,
    disableSslForTestsOnly: args.disableSslForTestsOnly
  });
  return { rowCount: rows.length };
}
