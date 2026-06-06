# Design: Named Connections + read-only foreign sources via declarations

**Date:** 2026-06-05
**Status:** Approved design — ready for implementation planning
**Scope:** Add named connections to `workflow_settings.yaml`; let a `declaration` reference a non-warehouse connection as a read-only source; auto-generate the bridge (FDW) so it's `ref()`-able; add a dev-time `introspect` command to pull the source schema. v1 = Postgres/Supabase warehouse reading BigQuery + Postgres sources.

## Summary

Today a SQLAnvil project targets one warehouse and every `ref()` resolves to a name
that warehouse can reach. Reading data from *another* system (e.g. BigQuery public
datasets from a Supabase project) requires the hand-written `wrapper({...})` FDW
action.

This feature introduces **named connections** and lets a `declaration` tag itself
with `connection: "<name>"`. SQLAnvil then generates the bridge needed for the
warehouse engine to read that source and exposes it as a normal `ref()`-able
object. A `sqlanvil introspect` command pulls the source's columns + metadata so
developers rarely hand-write column definitions.

## Design principles (carried in from prior decisions)

- **One read/write warehouse; all other connections are read-only.** Writing to a
  non-warehouse connection (reverse-ETL) is out of scope. See the project memory
  `project_sqlanvil_single_write_warehouse`.
- **Secrets stay out of committed config.** Connection *definitions* (non-secret)
  live in `workflow_settings.yaml`; *credentials* live in the gitignored
  `.df-credentials.json`. Consistent with the flat-config decision.
- **`compile` stays offline/deterministic and never reads `.df-credentials.json`.**
  Only `introspect` and `run` touch credentials/network. Therefore **generated DDL
  may use only non-secret values** — anything secret is provisioned by a one-time
  setup step, never baked into the compiled graph.
- **Additive / back-compatible.** The existing flat `warehouse: <platform>` +
  single-object `.df-credentials.json` keeps working unchanged as an implicit
  single connection. `connections:` is opt-in.

## Goals

- A `connections:` block in `workflow_settings.yaml`; `warehouse:` may name one of
  them as the R/W target.
- `connection:` is legal **only** on `declaration` (never table/view/incremental —
  those are written to the warehouse and can only live there).
- A connection-tagged declaration auto-generates the read bridge and is `ref()`-able
  with correct dependency ordering.
- `sqlanvil introspect` pulls a source table's columns (mapped to the warehouse
  dialect) + descriptions into a declaration's `columns:` block.

## Non-goals (explicit future phases)

- **BigQuery-as-warehouse** reading sources via `EXTERNAL_QUERY()` (Cloud SQL /
  AlloyDB / Spanner). Documented in the matrix; not built in v1.
- **Extract-load** bridging for pairs with no native federation (e.g. BigQuery
  warehouse → Supabase). Future phase.
- Writing to any non-warehouse connection (permanently out of scope).
- Source platforms beyond BigQuery and Postgres/Supabase in v1.

## Capability matrix

Rows = warehouse engine (where SQL runs). Columns = read-only source. The bridge is
whatever the **warehouse engine** natively supports.

| Warehouse ↓ \ Source → | BigQuery | Postgres / Supabase / Cloud SQL PG | Same engine |
|---|---|---|---|
| **Supabase / Postgres** | ✅ FDW (`wrappers` + `bigquery_wrapper`) | ✅ FDW (`postgres_fdw`) | plain declaration |
| **BigQuery** | plain declaration | ❌ no native path → extract-load (future) | plain declaration |
| **BigQuery → Cloud SQL/AlloyDB** | — | ✅ `EXTERNAL_QUERY()` (future phase) | — |

**v1 implements only the top row** (Postgres/Supabase warehouse → BigQuery + Postgres
sources). The rest ship as documentation with clear "planned" markers.

## Per-pair requirements

| Pair | Mechanism | Prerequisites | SQLAnvil generates (compile) | One-time setup (user/run) |
|---|---|---|---|---|
| PG/Supabase → BigQuery | FDW | `wrappers` ext (Supabase preinstalled; self-managed PG must install), billing-enabled GCP project | `create extension wrappers` + FDW + server (`sa_key_id` from the non-secret connection def) + foreign table | `vault.create_secret(<SA key JSON>)` once → its id is the connection's `saKeyId` |
| PG/Supabase → Postgres | FDW | `postgres_fdw` (core PG ext), network reachability | `create extension postgres_fdw` + server (host/port/db from the def) + foreign table | `CREATE USER MAPPING … OPTIONS(user, password)` once (the only secret-bearing DDL — never generated/committed) |
| BigQuery → Cloud SQL/AlloyDB *(future)* | `EXTERNAL_QUERY` | a BigQuery Connection resource, IAM grants | `EXTERNAL_QUERY('conn','…')` in ref resolution |
| BigQuery → Supabase/non-GCP PG *(future)* | extract-load | source driver, staging schema | staged copy + read |

For **live federation, SQLAnvil needs no source driver** — the warehouse engine does
the work. Source drivers (`@google-cloud/bigquery`, `pg` — both already deps) are
needed only by `introspect` (and a future extract-load).

## Configuration

### `workflow_settings.yaml` (committed, additive)

```yaml
warehouse: my_supabase          # names which connection is the R/W target
connections:
  my_supabase:
    platform: supabase
    defaultSchema: public
  bigquery_public:
    platform: bigquery
    project: bigquery-public-data
    dataset: geo_us_boundaries
    saKeyId: <vault-secret-id>     # non-secret Vault pointer; used in generated server DDL
```

- `connections` is a map of name → `{ platform, ... platform-specific non-secret defaults }`.
  This includes the BigQuery `saKeyId` (a non-secret Vault pointer) and Postgres
  `host`/`port`/`database` — everything the generated server DDL needs at compile.
- `warehouse:` may now be either (a) a legacy platform string (`supabase`/`postgres`/`bigquery`) — unchanged behavior, OR (b) the **name of a connection** in `connections`. Resolution: if the value matches a connection name, use that connection; else treat it as a legacy platform string.

### `.df-credentials.json` (gitignored)

Holds **secrets only**, used by `run` (the warehouse) and `introspect` (sources) —
never by `compile`. Back-compat: a single connection object (today's shape) still
works. With named connections, it becomes a map keyed by connection name:

```json
{
  "my_supabase":     { "host": "...", "port": 5432, "database": "postgres", "user": "postgres.<ref>", "password": "...", "sslMode": "require" },
  "bigquery_public": { "credentials": "<service-account-key-JSON-or-path>" }
}
```

- `my_supabase` is the warehouse (its password is used by `run`).
- `bigquery_public`'s real service-account key lives here too, but is used **only by
  `introspect`** to read the source schema directly via the BigQuery API. It is *not*
  used in any generated DDL (the server DDL references the non-secret `saKeyId` from
  the connection def instead). For a Postgres source, its `user`/`password` here are
  used by `introspect` and to create the one-time user mapping.

Resolution rule: if the JSON has a key matching a connection name, use it; otherwise
treat the whole object as the single (legacy) connection's credentials.

### The declaration

```sql
-- definitions/sources/zip_codes.sqlx
config {
  type: "declaration",
  connection: "bigquery_public",
  schema: "geo_us_boundaries",
  name: "zip_codes",
  columnTypes: {                 // name → SQL type; drives CREATE FOREIGN TABLE
    zip_code: "text",
    internal_point_lat: "float8",
    internal_point_lon: "float8"
  },
  columns: {                     // existing: name → description (optional metadata)
    zip_code: "5-digit US ZIP code"
  }
}
```

- `connection` is a new optional field on `DeclarationConfig`. It is **only valid on
  declarations** — other action types' config protos have no `connection` field, so
  setting it on a table/view/incremental is rejected by proto validation.
- `columnTypes` is a new `map<string,string>` (column name → SQL type) on
  `DeclarationConfig`, used to generate `CREATE FOREIGN TABLE`. The existing
  `columns` field keeps its current meaning — **column descriptions** (descriptors),
  optional everywhere, unchanged.
- **Conditional rule:** plain declarations (no `connection`) are unchanged —
  `columnTypes` and `columns` both optional. A declaration with `connection` that
  bridges via FDW **requires `columnTypes`** (compile error if missing, pointing at
  `introspect`). `columns` (descriptions) stays optional.

## Bridge compilation (v1: Postgres/Supabase warehouse, FDW)

When the compiler encounters a declaration whose `connection` differs from the
warehouse connection and the warehouse engine is Postgres/Supabase:

1. Emit the FDW scaffolding for that connection's `platform` (reusing the existing
   `Wrapper`/`ForeignTable` machinery) using **only non-secret values from the
   connection definition**: extension + FDW + server (BigQuery: `sa_key_id` from the
   def; Postgres: host/port/db from the def), and a `create foreign table` for the
   declared table in a derived local schema (e.g. `<connection>_ext`), using the
   declared `columnTypes`. The secret-bearing credential step (the Vault secret for
   BigQuery, the `CREATE USER MAPPING` for Postgres) is a documented one-time setup —
   **never generated into the compiled graph**.
2. Rewrite `ref("<name>")` for that declaration to the local foreign-table handle.
3. Wire dependency edges (`model → foreign table → server setup`) so ordering is
   correct — exactly as the current `wrapper({foreignTables})` does. The
   connection feature is the high-level front-end; `wrapper()` remains the
   low-level escape hatch.

If `connection` == the warehouse connection (or unset), the declaration behaves as
today (plain reference, no bridge).

## `sqlanvil introspect` (v1)

```bash
sqlanvil introspect <connection> <schema>.<table> [--output definitions/sources/<name>.sqlx]
```

- Connects **directly to the source** using that connection's credentials (via the
  already-shipped drivers), reads columns + types + table/column descriptions.
- Maps source types → the warehouse dialect via a per-platform mapping table (v1:
  BigQuery→Postgres; Postgres→Postgres is largely identity). Starter BigQuery→PG
  map: `STRING→text`, `INT64→bigint`, `FLOAT64→float8`, `NUMERIC→numeric`,
  `BOOL→boolean`, `TIMESTAMP→timestamptz`, `DATE→date`, `BYTES→bytea`,
  `JSON→jsonb`, `GEOGRAPHY→text` (WKT). Unmapped types → error listing the type.
- Writes (or updates) a `declaration` `.sqlx` with `connection`, `schema`, `name`,
  the filled `columnTypes: {}` (name → mapped SQL type), and — when the source has
  column comments — `columns: {}` descriptions.
- **Network-touching and explicit** — never invoked by `compile`/`run`. Run it once
  when adding or changing a source.

## Error handling

- `connection` on a non-declaration action → rejected by proto validation (no
  `connection` field on those configs).
- `connection`-tagged declaration missing `columnTypes` (FDW bridge) → compile error
  ("declaration '<name>' on connection '<c>' requires `columnTypes`; run `sqlanvil
  introspect <c> <schema>.<table>`").
- Unknown `connection` name (not in `connections`) → compile error.
- Unsupported warehouse→source pair (e.g. BigQuery→Supabase in v1) → compile error
  naming the pair and that it needs a future mechanism.
- `introspect` against an unreachable source / unmapped type → clear runtime error.

## Testing strategy

- **Core (unit, TDD):** connection config parsing + back-compat (flat string and
  single-object creds still resolve); `connection` rejected on non-declarations;
  conditional `columnTypes` rule (optional without connection, required with FDW
  connection); bridge compilation emits correct FDW DDL + ref rewrite + dependency
  edges for a BigQuery and a Postgres source; unknown-connection and unsupported-pair
  errors.
- **Introspect (unit):** type-mapping tables (BigQuery→PG, PG→PG) and sqlx codegen
  from a fixture schema (no live network — feed a captured schema object).
- **Integration:** extend the existing Docker Postgres/Supabase specs — a
  Postgres→Postgres FDW declaration reads real rows; reuse the proven
  Supabase→BigQuery path for the BigQuery case (live, manual).

## Open items deferred to the plan

- Derived local schema naming for foreign tables (`<connection>_ext` vs explicit).
- Exact `introspect` output ergonomics (stdout vs file write; overwrite/merge of an
  existing declaration).
- Whether `warehouse:`-as-connection-name and legacy-platform-string share one field
  or get disambiguated explicitly.
