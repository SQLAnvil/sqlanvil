import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { sqlanvil } from "sa/protos/ts";

/**
 * Shared materialization half of runner-extract: create the `<conn>_ext` target table in the
 * write warehouse (Postgres/Supabase) from the declaration's columnTypes and batch-insert the
 * extracted rows. The read half is per-platform (bigquery_extract.ts, mysql_extract.ts).
 */

// Postgres allows at most 65535 bind params per statement; keep batches well under that.
const MAX_PARAMS_PER_INSERT = 60000;

const quoteIdent = (id: string) => `"${String(id).replace(/"/g, '""')}"`;

export interface LoadRowsArgs {
  /** The write-warehouse (Postgres/Supabase) connection to materialize into. */
  pg: sqlanvil.IPostgresConnection;
  target: sqlanvil.ITarget;
  /** Column name -> SQL type, defining the materialized table. */
  columnTypes: { [key: string]: string };
  rows: any[];
  /** Per-platform value coercion applied to every cell (e.g. unwrap BigQuery `{value}`). */
  coerce?: (v: any) => any;
  /** Test-only: skip real SSL negotiation against a local Postgres. */
  disableSslForTestsOnly?: boolean;
}

export async function loadRowsIntoPostgres(args: LoadRowsArgs): Promise<void> {
  const { target, columnTypes, rows } = args;
  const cols = Object.keys(columnTypes);
  const coerce = args.coerce || ((v: any) => (v === undefined ? null : v));

  const pg = await PostgresDbAdapter.create(args.pg, {
    disableSslForTestsOnly: args.disableSslForTestsOnly
  });
  try {
    const qualified = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
    const colDefs = cols.map(c => `${quoteIdent(c)} ${columnTypes[c]}`).join(", ");
    await pg.execute(`create schema if not exists ${quoteIdent(target.schema)}`);
    // Drop whatever already holds the name — a FOREIGN table (the connection used `mode: fdw`
    // before) or a plain table (a previous extract run). The drops must match the relation kind:
    // `drop foreign table if exists` ERRORS (not skips) when the name is a plain table, and vice
    // versa — IF EXISTS only guards absence. Dependents (downstream views) are rebuilt by the
    // rest of the run anyway.
    const { rows: existing } = await pg.execute(
      `select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
        `where n.nspname = $1 and c.relname = $2`,
      { params: [target.schema, target.name] }
    );
    const relkind = existing[0]?.relkind;
    if (relkind === "f") {
      await pg.execute(`drop foreign table ${qualified} cascade`);
    } else if (relkind === "v") {
      await pg.execute(`drop view ${qualified} cascade`);
    } else if (relkind) {
      await pg.execute(`drop table ${qualified} cascade`);
    }
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
  } finally {
    await pg.close();
  }
}
