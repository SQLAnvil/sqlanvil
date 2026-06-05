# Design: Cross-warehouse mailing list (extend `foreign_wrapper` + example)

**Date:** 2026-06-05
**Status:** Approved design — ready for implementation planning
**Scope:** One core capability (extend the `foreign_wrapper` action) plus one showcase example.

## Summary

Build a publishable example that generates a mailing list of customers who
purchased in the last year and live within a given radius of a target ZIP code —
joining **operational e-commerce data in Supabase** with **Google's
`bigquery-public-data.geo_us_boundaries.zip_codes`** geo data, queried live via a
BigQuery Foreign Data Wrapper.

Delivering this seamlessly requires extending SQLAnvil's `foreign_wrapper` action
so a single config declares the whole BigQuery FDW bridge (extension → wrapper →
credential → server → foreign table) and exposes the foreign table(s) as
`ref()`-able targets. The action is designed **Postgres-first** (FDW is core
PostgreSQL); only the credential strategy varies by warehouse.

## Goals

- Extend `foreign_wrapper` to emit a complete, correct FDW setup for the BigQuery
  wrapper, including the foreign table(s) and credential wiring.
- Make the foreign tables `ref()`-able so downstream models consume them like any
  other source.
- Ship a self-contained, runnable example under `examples/` that doubles as an
  integration-test fixture.
- Keep secrets out of committed config — the service-account key is referenced,
  never embedded.

## Non-goals

- A generic provider catalog beyond `bigquery` (the preset is extensible later;
  generic FDW is still reachable via explicit `wrapper`/`handler`/`validator`).
- Running the BigQuery wrapper on managed Postgres that lacks the `wrappers`
  extension (RDS/Cloud SQL). Plain-Postgres support targets generic FDW
  (`postgres_fdw`, etc.) and self-managed Postgres with `wrappers` installed.
- A hosted/no-setup demo. The live-FDW path intentionally requires a GCP
  service-account key with a billing-enabled project (public-data queries are
  free up to the monthly tier but still need a billing project).

## Background

- A `declaration` registers a *name*; it never creates anything. In a Supabase
  project, a declaration pointing at a BigQuery path would compile to
  `select * from bigquery-public-data.…`, which Postgres cannot resolve.
- The bridge that lets Supabase "see" a BigQuery table is a `create foreign table`
  backed by the Supabase `wrappers` BigQuery FDW. Once it exists, the rest of the
  pipeline is pure Supabase/Postgres.
- Today's `foreign_wrapper` action (`core/actions/wrapper.ts`) emits only
  `create extension "<wrapper>"` (wrong extension name for Supabase's BigQuery
  FDW) + `create server`. It does not create the FDW handler, the credential, or
  any foreign table.
- FDW is a core PostgreSQL feature (`CREATE FOREIGN DATA WRAPPER/SERVER/USER
  MAPPING/FOREIGN TABLE`). Supabase-specific pieces are limited to (a) the
  preinstalled `wrappers` extension that provides the BigQuery handler and (b)
  Vault (`vault.create_secret`) for secret storage.

## Part 1 — Core change: extend the `foreign_wrapper` action

### Config surface (C-on-A: preset layered on a rich single action)

```js
config {
  type: "foreignWrapper",
  provider: "bigquery",              // preset → wrappers ext + bigquery handler/validator
  server: "bigquery_srv",
  serverOptions: {
    project_id: "bigquery-public-data",
    dataset_id: "geo_us_boundaries"
  },
  credential: {                      // a reference, never the key itself
    secretName: "bigquery_sa",       // vault secret name (Supabase) / mapping name (plain PG)
    from: "GCP_SA_KEY"               // env var OR a field in .df-credentials.json holding the JSON
  },
  foreignTables: [
    {
      name: "zip_codes",             // → ref("zip_codes") works downstream
      schema: "bq_ext",
      options: { table: "zip_codes", location: "US" },
      columns: { zip_code: "string", internal_point_lat: "float8", internal_point_lon: "float8" }
    }
  ]
}
```

### Proto changes (`protos/configs.proto`, `ForeignWrapperConfig`)

Existing fields `name` (1), `wrapper` (2), `server` (3), `options` (4),
`filename` (5), `dependency_targets` (6) are preserved. Add:

- `string provider = 7;` — preset key (`"bigquery"` initially).
- `string handler = 8;` / `string validator = 9;` — explicit overrides for
  generic FDW; required when `provider` is absent.
- `WrapperCredential credential = 10;` — nested message `{ string secret_name = 1;
  string from = 2; }`.
- `repeated ForeignTable foreign_tables = 11;` — nested message
  `{ string name = 1; string schema = 2; map<string,string> options = 3;
  map<string,string> columns = 4; }`.
- `server_options` carries the server option map. **Proposed:** reuse existing
  field 4 (`options`) as `server_options` for back-compat; final field number
  confirmed in the implementation plan (see Open items).

### Emitted DDL (in dependency order)

1. `create extension if not exists wrappers` — replaces today's incorrect
   `create extension "<wrapper>"`. (Preset-derived; for generic FDW the user's
   `wrapper`/extension is used as-is.)
2. `create foreign data wrapper <wrapper> handler <handler> validator <validator>`
   — for `provider: "bigquery"`: `bigquery_wrapper` /
   `big_query_fdw_handler` / `big_query_fdw_validator`.
3. Credential:
   - **Supabase:** `select vault.create_secret('<json>', '<secret_name>')`,
     referenced from the server as `sa_key_id`.
   - **Plain Postgres:** `create user mapping` / inline server option (no Vault).
   The `<json>` is resolved at run time from `credential.from` (env var or
   `.df-credentials.json` field), never written into compiled artifacts that get
   committed.
4. `create server <server> foreign data wrapper <wrapper> options(<server_options>
   [+ sa_key_id])`.
5. One `create foreign table <schema>.<name> (<columns>) server <server>
   options(<table options>)` per `foreign_tables[]` entry.

### `ref()`-able foreign tables

Each `foreign_tables[]` entry must become a target in the compiled graph so
downstream models can `ref("zip_codes")`. Mechanism options (final choice made in
the implementation plan):

- Emit each foreign table as an operation with `hasOutput: true`, whose target is
  `<schema>.<name>`, depending on the server-setup action; **or**
- Emit a companion `declaration` target per foreign table.

Either way, the FDW scaffolding (steps 1–4) is a dependency of the foreign-table
targets, so ordering is correct via the normal DAG.

### Warehouse portability

- Action is available on **both** `postgres` and `supabase` adapters.
- The only warehouse-specific branch is the credential strategy (Vault vs user
  mapping/inline).
- `provider: "bigquery"` realistically requires the `wrappers` extension
  (Supabase, or self-managed PG with it installed). Generic FDW
  (`wrapper`/`handler`/`validator` explicit) works on any Postgres.

### Testing (TDD)

- Unit tests in `core/actions/` asserting the compiled DDL for: the bigquery
  preset; an explicit generic-FDW override; the Supabase credential branch (Vault)
  vs the plain-Postgres branch (user mapping); and the `ref()`-ability of foreign
  tables.
- Compile error tests: unknown `provider`; missing `handler`/`validator` when no
  `provider`.
- The example project serves as the integration fixture (see Part 2 testing).

## Part 2 — The example (`examples/supabase_bigquery_mailing_list/`)

### Layout

```
workflow_settings.yaml        warehouse: supabase; vars: target_zip, radius_miles, purchased_since_days
.df-credentials.example.json  pooler connection + GCP_SA_KEY reference
definitions/
  sources/bigquery_zip_codes.sqlx    type: foreignWrapper (provider bigquery → foreign table zip_codes)
  staging/stg_zip_codes.sqlx         view:  select zip, lat, lon from ref("zip_codes")
  staging/zip_codes_cache.sqlx       table: select * from ref("stg_zip_codes")   ← materializes BQ → Supabase
  operational/customers.sqlx         table from VALUES (sample customers w/ zip)
  operational/sales_orders.sqlx      table from VALUES (sample orders w/ order_date)
  marts/mailing_list_candidates.sqlx view:  join + PostGIS distance + recency/radius filters
  marts/mailing_list.sqlx            table: final landed result
  assertions/assert_email_non_null.sqlx
  assertions/assert_distance_non_negative.sqlx
```

### Distance logic (mirrors acuantia)

`ST_Distance(target_centroid::geography, customer_zip_centroid::geography) /
1609.34` → miles. Filter to `<= radius_miles` and to customers with at least one
order in the last `purchased_since_days`. Target ZIP and radius come from
`workflow_settings.yaml` `vars` so the mailing list is parameterizable. PostGIS is
available on Supabase; `ST_MakePoint(lon, lat)::geography` builds the centroids
from the cached `internal_point_lon`/`internal_point_lat`.

### Self-contained data

`customers` and `sales_orders` are seeded from `VALUES` (consistent with the
existing `examples/postgres_shop` and the starter template), so the example runs
end-to-end against a fresh Supabase project plus a GCP service-account key — no
external operational backend required.

## Data flow

```
bigquery-public-data.geo_us_boundaries.zip_codes
        │  (live FDW query)
        ▼
zip_codes (foreign table, ref-able)
        │
        ▼
stg_zip_codes (view)  ──►  zip_codes_cache (table, materialized in Supabase)
                                   │
customers ─┐                       │
sales_orders ┼──────────────────►  mailing_list_candidates (view: join + distance + filters)
            │                              │
            ▼                              ▼
                                    mailing_list (table)
```

## Error handling

- Missing/invalid `GCP_SA_KEY` (the `credential.from` source) → fail fast at the
  credential step with a clear message, consistent with the adapter's existing
  fail-fast connection probe.
- Unknown `provider` → compile error listing supported providers.
- No `provider` and no `handler`/`validator` → compile error explaining generic
  FDW requires them.
- Foreign-table column type not mappable → compile error naming the column.

## Open items deferred to the implementation plan

- Final mechanism for `ref()`-able foreign tables (operation `hasOutput` vs
  companion declaration).
- Exact run-time resolution of `credential.from` (env var vs `.df-credentials.json`
  field precedence).
- Whether `server_options` reuses proto field 4 or takes a new field number.

## Testing strategy (rollup)

- **Core:** TDD unit tests for compiled DDL and compile errors (above).
- **Integration:** the example compiles cleanly (`sqlanvil compile .`) in CI
  without credentials; a live run against a Supabase project + GCP SA key is the
  manual/optional integration check, paralleling the existing
  `tests/integration` Postgres/Supabase specs.
