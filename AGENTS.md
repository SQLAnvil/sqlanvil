# AGENTS.md — Writing sqlanvil data projects

Cross-agent guide (Claude, Antigravity, Gemini, Cursor, Copilot, …) for **authoring sqlanvil
data projects** (`.sqlx` models, `workflow_settings.yaml`, `.df-credentials.json`) that target
**PostgreSQL / Supabase**.

> Working on the sqlanvil **codebase itself** (TypeScript, Bazel, protos)? See `CLAUDE.md`.
> This file is about writing *projects that sqlanvil compiles and runs.*
> Canonical copy of this guidance also ships as the Claude skill
> `sqlanvil-engineering-fundamentals` — keep the two in sync.

## What sqlanvil is

sqlanvil is a fork of Dataform repositioned for PostgreSQL and Supabase. Your Dataform/BigQuery
instincts are **mostly right** — `.sqlx` files, `config {}`, `${ref()}`, `${self()}`,
declarations, assertions, tags, incremental tables, `pre_operations`/`post_operations` all work
the same. **This file is the delta**: where assuming Dataform/BigQuery produces broken sqlanvil
code.

**Core rule:** on Postgres/Supabase, reach for the **`postgres: {}` config block** and idiomatic
Postgres — never BigQuery options or hand-rolled DDL workarounds.

**Source of truth for config fields:** `protos/configs.proto` (`PostgresOptions`,
`PostgresConnection`, `TableConfig`, `IncrementalTableConfig`, `ViewConfig`). When unsure, read it.

## The deltas that bite (read before writing anything)

### 1. Project config: `workflow_settings.yaml`, warehouse is Postgres
```yaml
warehouse: postgres            # flat string ("postgres" or "supabase") — NOT nested
defaultDataset: public         # the Postgres SCHEMA
defaultAssertionDataset: dataform_assertions
dataformCoreVersion: 3.0.x
vars:
  someVar: value
```
Drop `defaultProject` and `defaultLocation` (BigQuery-only). `dataform.json` is the legacy
upstream name; sqlanvil uses `workflow_settings.yaml`.

### 2. Connection: `.df-credentials.json` — flat `PostgresConnection`
Filename is literally `.df-credentials.json` (fork kept upstream's name; default, override with
`--credentials`). Flat `PostgresConnection` — **not** nested under `"postgres"`, **not** the
BigQuery shape:
```json
{
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password": "password",
  "sslMode": "require",
  "defaultSchema": "public"
}
```
Exact field names: `host port database user password sslMode defaultSchema` — **not**
`username`/`databaseName`/`ssl`. Gitignore it. Supabase: `host: db.<ref>.supabase.co`, port 5432
(or 6543 pooler), `sslMode: "require"`.

### 3. Storage, indexes, partitioning are FIRST-CLASS — never hand-roll DDL
Use `postgres: {}` on `type: "table"` and `type: "incremental"`. Do **not** create indexes or set
fillfactor via `post_operations`.
```sqlx
config {
  type: "table",
  postgres: {
    fillfactor: 80,
    unlogged: false,
    tablespace: "fast_ssd",
    indexes: [
      { name: "idx_email", columns: ["email"], unique: true },
      { name: "idx_props", columns: ["props"], method: 2, opclass: "jsonb_path_ops" }
    ]
  }
}
```
**Index `method` is a NUMERIC ENUM, not a string:** `BTREE=0, HASH=1, GIN=2, GIST=3, BRIN=4`.
`method: "btree"` fails the config type check (parser uses protobufjs `create()`). Omit for btree.
Index fields: `name`, `columns[]`(array), `method`(int), `where`(partial predicate),
`unique`(bool), `include[]`(array, covering), `opclass`(**single string** applied to every indexed
column — `opclass: "gin_trgm_ops"`, **not** an array).

### 4. Native partitioning via `postgres.partition` (not `partitionBy`/`clusterBy`)
```sqlx
postgres: {
  partition: {
    kind: 0,                                   // RANGE=0, LIST=1, HASH=2 (numeric enum)
    columns: ["order_date"],
    partitions: [
      { name: "y2024", values: "FROM ('2024-01-01') TO ('2025-01-01')" }
    ],
    includeDefault: true
  }
}
```
`values` is the raw `FOR VALUES` body matching `kind`. No `clusterBy` — use `indexes`.

### 5. Materialized views: `type: "view", materialized: true`
Emits `CREATE MATERIALIZED VIEW`. Default = **drop + recreate every run** (also picks up
definition changes). **Known limitation:** `ViewConfig` has no `postgres: {}` block, so you cannot
set `refreshPolicy`/`noData` from a view's `config` today — `postgres: {...}` in a view config
won't parse. For in-place `REFRESH MATERIALIZED VIEW`, add a `type: "operations"` action running
`refresh materialized view ${ref("mv_name")}` that depends on the matview.

### 6. Statement separator is `---`, never `;`
Three dashes on their own line separate statements in `operations`/`pre_operations`/
`post_operations`. sqlanvil never splits on `;`, so PL/pgSQL `$$ ... ; ... $$` bodies survive. A
`table`/`view` body is exactly one `SELECT` — no `---`.

### 7. Procedures / functions / triggers / extensions / grants → `type: "operations"`
No dedicated action type; the operations generator is dialect-agnostic.
```sqlx
config { type: "operations", hasOutput: false }
CREATE OR REPLACE FUNCTION marts.recalc() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- body; semicolons here are fine
END;
$$
---
CALL marts.recalc()
```

### 8. Two different `uniqueKey`s — do not confuse them
- Top-level `uniqueKey: ["id"]` on an **incremental** = upsert/merge key (`INSERT ... ON
  CONFLICT`). Controls incremental writes.
- `assertions: { uniqueKey: ["id"] }` = generates a uniqueness **assertion**. A quality check.

Independent; can coexist.

### 9. Primary keys / one-time DDL on incrementals → `post_operations`
Plain `pre_operations`/`post_operations` run only on **create + `--full-refresh`**;
`incrementalPre/PostOps` run on appends. So `ALTER TABLE ${self()} ADD PRIMARY KEY (...)` goes in
`post_operations` and won't re-run/error on every append. Matview post-ops re-run every build —
keep them idempotent (matviews can't have PKs anyway).

### 10. Metadata + assertions (same as Dataform, works on PG)
- `description:` (table) + `columns: { col: "..." }` (per-column) → `COMMENT ON
  TABLE|VIEW|MATERIALIZED VIEW|COLUMN`. Document every table.
- `assertions: { uniqueKey, uniqueKeys: [["a","b"],["c"]], nonNull: [...], rowConditions: [...] }`.
  Standalone = `type: "assertion"` whose `SELECT` returns offending rows (passes iff zero rows).

### 11. No BigQuery-isms, ever
No `bigquery: {}`, `partitionBy`, `clusterBy`, `OPTIONS(...)`, `bigqueryPolicyTags`, backticked
`` `project.dataset.table` ``, or `CREATE ... NOT ENFORCED`. Use the `postgres:` equivalents and
double-quoted identifiers.

### 12. CLI: `./scripts/run <verb>` (no global `dataform`, no `npm run`)
```bash
./scripts/run compile <projectDir>
./scripts/run run     <projectDir> --credentials <projectDir>/.df-credentials.json
./scripts/run run     <projectDir> --credentials ... --full-refresh
./scripts/run run     <projectDir> --credentials ... --actions <name> --include-deps
./scripts/run test    <projectDir> --credentials ...
```
Boot a local PG with `./tools/postgres/run-postgres-db.sh`. `--dry-run` only validates BigQuery
today; on Postgres it does not EXPLAIN-validate SQL (known gap).

### 13. Supabase extras (`warehouse: supabase`)
`supabase: {}` adds `enableRls`, `publishToRealtime`, `ownerRole`,
`vectors: [{ column, dimensions, indexType }]`. Action types: `rlsPolicy`,
`realtimePublication`, `wrapper`, `vectorIndex`. `enableRls` only flips RLS on — declare policies
via the `rlsPolicy` action.

## Quick reference: Dataform/BigQuery → sqlanvil/Postgres

| You'd reach for (Dataform/BQ) | Use instead (sqlanvil/PG) |
|---|---|
| `dataform.json` | `workflow_settings.yaml`, `warehouse: postgres` |
| `defaultProject` / `defaultLocation` | drop them; `defaultDataset` = schema |
| `bigquery: { partitionBy, clusterBy }` | `postgres: { partition: {...}, indexes: [...] }` |
| `OPTIONS(...)` / table options | `postgres: { fillfactor, unlogged, tablespace }` |
| `CREATE INDEX` in `post_operations` | `postgres: { indexes: [...] }` |
| `method: "btree"` (string) | `method: 0` (numeric enum) |
| `;` between statements | `---` |
| `CREATE PROCEDURE` + run separately | `type: "operations"` |
| creds `{postgres:{username,databaseName,ssl}}` | flat `{host,port,database,user,password,sslMode,defaultSchema}` |
| matview `refreshPolicy` in view config | not supported — use `operations` REFRESH |
| `dataform run` / `npm run` | `./scripts/run run ... --credentials` |

## Red flags — you're reverting to BigQuery priors

`dataform.json` · `defaultProject` · `bigquery: {` · `partitionBy` · `clusterBy` · `OPTIONS(` ·
`method: "` (string) · `CREATE INDEX`/`SET (fillfactor` in `post_operations` · `;` between
statements · `postgres: {` inside a `type: "view"` · a bare `dataform`/`npm run` command.

When unsure of a `postgres:` field name or enum value, read `protos/configs.proto`.
