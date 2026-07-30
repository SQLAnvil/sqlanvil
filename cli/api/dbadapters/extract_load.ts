import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { sqlanvil } from "sa/protos/ts";

/**
 * Shared materialization half of runner-extract: create the `<conn>_ext` target table in the
 * write warehouse (Postgres/Supabase) from the declaration's columnTypes and batch-insert the
 * extracted rows. The read half is per-platform (bigquery_extract.ts, mysql_extract.ts).
 *
 * Two entry points: `createPgLoader` (streaming — callers feed batches as they read the source,
 * bounding memory) and `loadRowsIntoPostgres` (buffered convenience wrapper over the loader).
 */

// Postgres allows at most 65535 bind params per statement; keep batches well under that.
const MAX_PARAMS_PER_INSERT = 60000;

const quoteIdent = (id: string) => `"${String(id).replace(/"/g, '""')}"`;

export interface PgLoaderArgs {
  /** The write-warehouse (Postgres/Supabase) connection to materialize into. */
  pg: sqlanvil.IPostgresConnection;
  target: sqlanvil.ITarget;
  /** Column name -> SQL type, defining the materialized table. */
  columnTypes: { [key: string]: string };
  /** Per-platform value coercion applied to every cell (e.g. unwrap BigQuery `{value}`). */
  coerce?: (v: any) => any;
  /** Test-only: skip real SSL negotiation against a local Postgres. */
  disableSslForTestsOnly?: boolean;
}

export interface PgLoader {
  /** Rows per INSERT statement that stays under the bind-param limit — a good batch size to feed. */
  batchRows: number;
  /** Insert one batch of source rows (any size; internally chunked to the param limit). */
  loadBatch(rows: any[]): Promise<void>;
  /** Release the warehouse connection. Always call (in a finally). */
  close(): Promise<void>;
}

/**
 * Create the target table (dropping whatever previously held the name) and return a loader for
 * feeding row batches. Uses a SINGLE warehouse connection — extracts run concurrently in a run,
 * and per-extract pools multiply against Supabase's session-pooler client cap.
 */
/** A source column and the identifier it materializes as. */
export interface FoldedColumn {
  /** As the source warehouse spells it — the key rows arrive under. */
  source: string;
  /** As the write warehouse stores it. */
  target: string;
}

/**
 * Map source columns onto the identifiers they materialize as, folding case.
 *
 * PostgreSQL folds unquoted identifiers to lower case and offers no case-insensitive identifier
 * mode, while BigQuery resolves column names case-insensitively. Carrying `Email` across
 * unchanged would mean writing `"Email"` at every reference for the rest of the project's life,
 * and any reference the source happened to spell `email` would stop resolving — at RUN time, not
 * compile time. Folding once, here, keeps the SQL that BigQuery accepted working unquoted, and
 * lower-case identifiers are the PostgreSQL convention anyway.
 *
 * The source name is retained deliberately: rows arrive keyed by the ORIGINAL name, so reading
 * them by the folded name yields undefined for every row — a table full of NULLs rather than an
 * error, which is the worst way for this to go wrong.
 */
export function foldColumns(
  columnTypes: { [key: string]: string },
  target: { schema?: string | null; name?: string | null },
): FoldedColumn[] {
  const cols = Object.keys(columnTypes).map(source => ({ source, target: source.toLowerCase() }));
  const byFolded = new Map<string, string[]>();
  for (const c of cols) {
    byFolded.set(c.target, [...(byFolded.get(c.target) ?? []), c.source]);
  }
  for (const [folded, sources] of byFolded) {
    if (sources.length > 1) {
      // Loud, because the alternative is one column silently overwriting the other.
      throw new Error(
        `Source ${target.schema}.${target.name} has columns that differ only in case ` +
          `(${sources.join(", ")}); PostgreSQL folds them to the same identifier "${folded}". ` +
          `Rename one at the source, or select them with distinct aliases.`,
      );
    }
  }
  return cols;
}

export async function createPgLoader(args: PgLoaderArgs): Promise<PgLoader> {
  const { target, columnTypes } = args;
  const coerce = args.coerce || ((v: any) => (v === undefined ? null : v));
  const cols = foldColumns(columnTypes, target);

  const pg = await PostgresDbAdapter.create(args.pg, {
    concurrencyLimit: 1,
    disableSslForTestsOnly: args.disableSslForTestsOnly
  });
  try {
    const qualified = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
    const colDefs = cols.map(c => `${quoteIdent(c.target)} ${columnTypes[c.source]}`).join(", ");
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
  } catch (e) {
    await pg.close();
    throw e;
  }

  const colIdents = cols.map(c => quoteIdent(c.target)).join(", ");
  const qualified = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
  const batchRows = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS_PER_INSERT / cols.length)));

  return {
    batchRows,
    async loadBatch(rows: any[]) {
      for (let i = 0; i < rows.length; i += batchRows) {
        const batch = rows.slice(i, i + batchRows);
        const params: any[] = [];
        const tuples = batch.map((row, r) => {
          const placeholders = cols.map((c, ci) => `$${r * cols.length + ci + 1}`);
          // Read by the SOURCE name — the row arrives keyed as the warehouse spelled it.
          cols.forEach(c => params.push(coerce(row[c.source])));
          return `(${placeholders.join(", ")})`;
        });
        await pg.execute(`insert into ${qualified} (${colIdents}) values ${tuples.join(", ")}`, {
          params
        });
      }
    },
    async close() {
      await pg.close();
    }
  };
}

export interface LoadRowsArgs extends PgLoaderArgs {
  rows: any[];
}

/** Buffered convenience wrapper: create the table and load an in-memory row array. */
export async function loadRowsIntoPostgres(args: LoadRowsArgs): Promise<void> {
  const loader = await createPgLoader(args);
  try {
    await loader.loadBatch(args.rows);
  } finally {
    await loader.close();
  }
}
