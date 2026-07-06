# AGENTS.md — Writing sqlanvil data projects

Cross-agent guide (Claude, Antigravity, Gemini, Cursor, Copilot, …) for **authoring sqlanvil
data projects** (`.sqlx` models, `workflow_settings.yaml`, `.df-credentials.json`) that target
**PostgreSQL / Supabase / MySQL / MariaDB**.

> Working on the sqlanvil **codebase itself** (TypeScript, Bazel, protos)? See `CLAUDE.md`.
> This file is about writing *projects that sqlanvil compiles and runs.*
> Canonical copy of this guidance also ships as the Claude skill
> `sqlanvil-engineering-fundamentals` — keep the two in sync.

## What sqlanvil is

sqlanvil is a fork of Dataform repositioned for PostgreSQL, Supabase, and MySQL/MariaDB. Your
Dataform/BigQuery instincts are **mostly right** — `.sqlx` files, `config {}`, `${ref()}`,
`${self()}`, declarations, assertions, tags, incremental tables, `pre_operations`/`post_operations`
all work the same. **This file is the delta**: where assuming Dataform/BigQuery produces broken
sqlanvil code.

**Core rule:** on Postgres/Supabase, reach for the **`postgres: {}` config block** and idiomatic
Postgres — never BigQuery options or hand-rolled DDL workarounds. **MySQL/MariaDB is different** —
smaller surface (no options block, no matviews) and several rules invert; see the MySQL section
below before authoring a `warehouse: mysql` project.

**Source of truth for config fields:** `protos/configs.proto` (`PostgresOptions`,
`PostgresConnection`, `TableConfig`, `IncrementalTableConfig`, `ViewConfig`). When unsure, read it.

## The deltas that bite (read before writing anything)

### 1. Project config: `workflow_settings.yaml`, warehouse is Postgres
```yaml
warehouse: postgres            # flat string ("postgres" or "supabase") — NOT nested
defaultDataset: public         # the Postgres SCHEMA
defaultAssertionDataset: sqlanvil_assertions
sqlanvilCoreVersion: 1.20.0    # sqlanvil's OWN SemVer line (NOT dataformCoreVersion); pin the current release
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
definition changes). Set Postgres options directly in the view config via `postgres: {}`:
```sqlx
config {
  type: "view",
  materialized: true,
  postgres: {
    refreshPolicy: "on_dependency_change",   // in-place REFRESH instead of drop+recreate
    noData: true,                            // WITH NO DATA (empty until first refresh)
    indexes: [{ name: "idx_mv_id", columns: ["id"], unique: true }]
  }
}
```
`refreshPolicy: "on_dependency_change"` runs `REFRESH MATERIALIZED VIEW` in place — but in-place
refresh does **not** pick up definition (SQL) changes; omit it for the safe drop+recreate default.

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

### 9. Primary keys / one-time DDL on incrementals → wrap in `when(!incremental())`
An **unwrapped** `pre_operations`/`post_operations` block runs on **every** run of an incremental —
the create *and* every append (it compiles into both the create-path and incremental-path ops). A
bare `ALTER TABLE ... ADD PRIMARY KEY` errors on the second run (`multiple primary keys`). Wrap
one-time DDL so it runs only on create + `--full-refresh`:
```sqlx
post_operations {
  ${when(!incremental(), `ALTER TABLE ${self()} ADD PRIMARY KEY (order_date)`)}
}
```
(The PK also gives the incremental upsert its `ON CONFLICT` target.) Matview post-ops re-run every
build — keep them idempotent (matviews can't have PKs anyway).

### 10. Metadata + assertions (same as Dataform, works on PG)
- `description:` (table) + `columns: { col: "..." }` (per-column) → `COMMENT ON
  TABLE|VIEW|MATERIALIZED VIEW|COLUMN`. Document every table.
- `assertions: { uniqueKey, uniqueKeys: [["a","b"],["c"]], nonNull: [...], rowConditions: [...] }`.
  Standalone = `type: "assertion"` whose `SELECT` returns offending rows (passes iff zero rows).

### 11. No BigQuery-isms, ever
No `bigquery: {}`, `partitionBy`, `clusterBy`, `OPTIONS(...)`, `bigqueryPolicyTags`, backticked
`` `project.dataset.table` ``, or `CREATE ... NOT ENFORCED`. Use the `postgres:` equivalents and
double-quoted identifiers.

### 12. CLI: `sqlanvil <verb>` (the installed CLI — no global `dataform`, no `npm run`)
```bash
sqlanvil init      <projectDir> --warehouse postgres   # or supabase/mysql — scaffolds workflow_settings.yaml + a .df-credentials.json template (BigQuery is the default; it needs a GCP project + location)
sqlanvil compile   <projectDir>
sqlanvil run       <projectDir> --credentials <projectDir>/.df-credentials.json
sqlanvil run       <projectDir> --credentials ... --full-refresh
sqlanvil run       <projectDir> --credentials ... --actions <name> --include-deps
sqlanvil validate  <projectDir> --credentials ...      # EXPLAIN-validate the whole DAG without executing
sqlanvil test      <projectDir> --credentials ...
```
Install with `npm i -g @sqlanvil/cli`. (Working from a sqlanvil repo checkout instead of the installed CLI? Use `./scripts/run <verb>` in place of `sqlanvil <verb>`.)
Boot a local PG with `./tools/postgres/run-postgres-db.sh`.

**`validate` / `run --dry-run` (>=1.9):** walks the DAG in dependency order, `EXPLAIN`-checks each
model against the live warehouse in a throwaway shadow schema (empty stubs let downstream
`${ref()}`s resolve), and reports **PASS / FAILURE / BLOCKED** (blocked = only an upstream failed)
/ SKIPPED (operations, imports). `run --dry-run` on Postgres/Supabase/MySQL *validates* — it does
not execute. Any FAILURE/BLOCKED exits non-zero. (BigQuery: native server-side dry-run.) Python
script actions (>=1.20) get an env check instead of EXPLAIN: interpreter vs `pythonVersion`,
requirements vs installed packages, syntax — without executing the script.

**`run --graph <file>` (>=1.17):** executes a stored `compile --json` output directly — no compile,
no project source needed (a bare dir + credentials works). What runs is exactly what was compiled;
environment overrides are baked in (`--environment` with `--graph` is rejected); selection flags
still apply. The release-artifact pattern: compile once, run the identical graph later/elsewhere.

**Queryable artifacts (>=1.10):** `compile`/`run` write Parquet artifacts under `<projectDir>/target/`
(gitignore it). `sqlanvil query "<sql>"` runs SQL over them (views: `actions`, `dependencies`,
`columns`, `runs`); `sqlanvil inspect` prints a summary; `sqlanvil docs` renders an HTML catalog to
`target/docs/index.html`. Warehouse-agnostic — no connection needed.

**Named environments (`--environment <name>`):** define dev/staging/prod in an `environments:`
block in `workflow_settings.yaml`; each bundles non-secret overrides + a pointer to a gitignored
credentials file:
```yaml
environments:
  dev:  { schemaSuffix: dev,  credentials: .df-credentials.dev.json }
  prod: { defaultDatabase: prod_db, vars: { region: us-prod }, credentials: .df-credentials.prod.json }
```
`sqlanvil run . --environment prod` loads prod's overrides + its credentials file (works on
compile/run/test). Precedence: **explicit CLI flag > environment > workflow_settings defaults**
(`vars` merge per-key). Each env's `credentials:` is a path to a **gitignored** `.df-credentials*.json`
file — secrets never go in `workflow_settings.yaml`. `--schema-suffix` stays the low-level primitive.

### 13. Supabase extras (`warehouse: supabase`)
`supabase: {}` adds `enableRls`, `publishToRealtime`, `ownerRole`,
`vectors: [{ column, dimensions, indexType }]`. Action types: `rlsPolicy`,
`realtimePublication`, `wrapper`, `vectorIndex`. `enableRls` only flips RLS on — declare policies
via the `rlsPolicy` action.

### 14. Declaring external sources: `type: "declaration"`
Reference a pre-existing, externally-managed table so `${ref()}` resolves and the DAG tracks it.
Two equivalent forms:
```sqlx
config { type: "declaration", schema: "raw", name: "orders" }   // one per .sqlx file
```
```js
declare({ schema: "raw", name: "orders" });                     // many per .js file
declare({ schema: "raw", name: "customers" });
```
**Declarations are exempt from `--schema-suffix` / `tablePrefix` / `datasetSuffix` — by design**
(`session.ts` passes declarations separately from the actions it renames). The suffix is not
applied to a declaration's own target, and `${ref()}` to a declared source resolves to the real
(unsuffixed) table even under `--schema-suffix dev` — so a dev run reads true sources while writing
to suffixed output. A declaration without a suffix is correct; don't "fix" it.

### 15. Cross-warehouse sources: named connections (BigQuery / Postgres / MySQL)

Read a table from ANOTHER warehouse via a **named connection** — never hand-roll an FDW. Declare
non-secret coordinates in `workflow_settings.yaml` under `connections:` (`platform: bigquery` with
`project`/`dataset`/`saKeyId`/`billingProject` (>=1.13, bill your project for read-but-not-bill
sources); `platform: postgres` with `host`/`port`/`database`/`defaultSchema`; `platform: mysql`
(>=1.18) with `host`/`port`/`database`). Secrets go in `.df-credentials.json`'s `connections.<name>`
map (postgres/mysql: user/password; BigQuery: SA `credentials` or a keyless short-lived
`accessToken`, >=1.14). Tag a declaration with `connection: "<name>"` + **`columnTypes` in
POSTGRES types** (compile error without them) — scaffold via
`sqlanvil introspect <conn> <schema.table> --output definitions/sources/<name>.sqlx` (maps
BigQuery/Postgres/MySQL types to PG). The write warehouse must be postgres/supabase; connections
are READ-ONLY sources (single write warehouse).

Two modes (`mode:` on the connection): **`fdw`** (default for bigquery/postgres — live foreign
table in `<conn>_ext`, needs `wrappers` + Vault on the warehouse) and **`runner-extract`**
(>=1.15 BigQuery; default and ONLY mode for mysql — `mode: fdw` on mysql is a compile error): the
CLI reads the source at run time and materializes a plain `<conn>_ext.<name>` table (1M rows /
512MB caps) — no Vault, no extensions, works on bare/ephemeral branches. Either way, downstream
just `${ref("<name>")}`s it.

### 16. File exports and imports (`type: "export"` >=1.8, `type: "import"` >=1.12)

Config-only actions moving FILES across the warehouse boundary (Parquet/CSV/JSON; local paths or
`s3://`/`gs://` — bucket creds under `storage:` in `.df-credentials.json`). **`import`** loads a
file into a `${ref()}`-able warehouse table (`import: { location, format, overwrite }`; `location`
is the verbatim source URI; `overwrite` defaults true; PG/Supabase via the DuckDB bridge, BigQuery
native `LOAD DATA` gs:// only, MySQL throws). **`export`** writes a query result to a file — a
terminal sink. `validate` marks imports SKIPPED and their downstream BLOCKED (expected). Hosted
SQLAnvil Cloud rejects LOCAL paths at compile — use object-store URIs there.

### 17. Python script actions (`python:` in actions.yaml, >=1.20)

Execution-time Python steps as DAG nodes — the staging/glue slot (download, unzip, API call)
before an `import`. Declared in `definitions/actions.yaml` (NOT a new file extension; NOT
compile-time like `.js`):

```yaml
actions:
  - python:
      name: fetch_data
      file: loader/fetch_data.py             # plain .py, path from project root
      args: ["northeast"]                     # sys.argv[1:]
      requirements: loader/requirements.txt   # optional; VALIDATED, never installed
      pythonVersion: ">=3.11"                 # optional PEP 440 specifier
      venv: .venv                             # optional; that venv's interpreter runs it
      dependencies: ["upstream_action"]
```

Contract: cwd = project dir; env `SA_VARS` (vars as JSON) + `SA_ACTION_NAME`; exit 0 = success;
30-min default timeout (`timeoutMillis` overrides). **No warehouse credentials are injected** —
the script stages FILES; a downstream `type: "import"` (with
`dependencyTargets: [{name: "fetch_data"}]`) loads them. Never have the script write to the
warehouse itself. `sqlanvil validate` checks the interpreter version, requirements vs installed
packages, and syntax WITHOUT executing (a failing script BLOCKs dependents); the user owns the
env — pip/uv install is their job, sqlanvil never installs. Hosted SQLAnvil Cloud rejects script
actions at compile — local CLI / BYO CI only. `python:` is sugar for the language-neutral
`script: { language: "python", ... }` (proto field names: `filename`, `depsFile`,
`runtimeVersion`, `envRoot`).

## MySQL / MariaDB (`warehouse: mysql`)

One adapter serves **both MySQL 8 and MariaDB 11** (same `warehouse: mysql`, same generated SQL;
MariaDB-specific features go through `operations`). Deliberately smaller than Postgres — several
deltas above **invert**.

- **Config:** `warehouse: mysql`; `defaultDataset` = the MySQL **database** ("schema" *is* the
  database — no catalog level). `sqlanvilCoreVersion: 1.5.0`+ (MySQL landed in 1.5.0).
- **Credentials:** flat **`MysqlConnection`** — `host port database user password sslMode`. **No
  `defaultSchema`** (unlike Postgres). `sslMode`: `"disable"` (local) or `"require"`. Port 3306.
  Identifiers compile to two-part backticks `` `db`.`table` ``.
- **`mysql: {}` block (indexes + table options + partitioning).** Declare secondary indexes
  (`indexes: [{ name?, columns, unique?, type? }]`) and table options (`engine`, `charset`,
  `collation`, `rowFormat`) in config — the role `postgres: {}` plays. Index `type:` is
  `"fulltext"` or `"spatial"` (1.19+; mutually exclusive with `unique`; spatial needs a NOT NULL
  SRID geometry column, which CTAS doesn't produce — usually needs a `post_operations` MODIFY
  first). Columns may carry a prefix length in MySQL's own syntax — `"body(50)"` → `` `body`(50) ``
  (required to index TEXT/BLOB). No `WHERE`/`INCLUDE`/`opclass` (Postgres-only). Partitioning via
  `mysql: { partition: {...} }` (1.11+). On matviews the block flows through `type: "view",
  materialized: true` (1.19+). Use `mysql: {}`, never `postgres: {}`, on a mysql model.
- **Incremental `uniqueKey` is enough** — compiles to `INSERT ... ON DUPLICATE KEY UPDATE` and the
  adapter auto-creates the unique index (`uq_<db>_<table>`) on first/`--full-refresh`. Don't add
  your own PK/unique for the merge.
- **Materialized views are emulated as a refreshed table snapshot** — `type: "view", materialized: true` builds a real table (drop + CTAS each run; refresh = re-run), honoring the `mysql:{}` block. No native matview, so it's read back as a table.
- **`description:`/`columns:` produce real table/column comments** — applied via `ALTER TABLE … COMMENT` / `MODIFY COLUMN … COMMENT` and read back from `information_schema`. Tables/incrementals only — MySQL views can't carry comments. Assertions also work.
- **A mysql WAREHOUSE can't read cross-warehouse sources** — only a postgres/supabase warehouse
  reads `connections`. MySQL/MariaDB **as a source** works (1.18+): declare a connection with
  `platform: mysql` + `host`/`port`/`database` and it is **runner-extract only** (no Postgres FDW
  for MySQL — `mode: fdw` is a compile error; omit `mode`, runner-extract is the default). The CLI
  reads `database.table` over the wire at run time (mysql2) and materializes a plain
  `<conn>_ext.<name>` table in the write warehouse, capped at 1M rows / 512MB. Declarations need
  `columnTypes` — scaffold with `sqlanvil introspect <conn> <db>.<table>` (MySQL introspect works).
  Credentials go in `.df-credentials.json`'s `connections` map: `{ host, port, user, password,
  sslMode? }`. An explicit `schema:` on the declaration overrides the source database.
- **`---` not `;`** (delta #6); **never `DELIMITER`** (client-only directive — a `CREATE PROCEDURE`
  body's internal `;` survive between `---` separators). Backtick-quote identifiers in raw DDL.
- CLI: `sqlanvil init <dir> --warehouse mysql`. Local engines: `./tools/mysql/run-mysql-db.sh`
  (mysql:8 on 3306, mariadb:11 on 3307).

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
| in-place matview refresh | `postgres: { refreshPolicy: "on_dependency_change" }` in the view config (else drop+recreate) |
| `dataform run` / `npm run` | `sqlanvil run ... --credentials` |
| `dataformCoreVersion:` | `sqlanvilCoreVersion:` (sqlanvil's own SemVer line) |
| hand-written FDW / foreign table to read another warehouse | named connection + `sqlanvil introspect` (delta #15) |
| `LOAD DATA` / hand-rolled `COPY` to ingest a file | `type: "import"` (>=1.12) |
| `EXPORT DATA` (BQ-only) | `type: "export"` (>=1.8) |
| hoping `--dry-run` validates | `sqlanvil validate` (>=1.9) — EXPLAIN-checks the whole DAG |

## Red flags — you're reverting to BigQuery priors

`dataform.json` · `defaultProject` · `bigquery: {` · `partitionBy` · `clusterBy` · `OPTIONS(` ·
`method: "` (string) · `CREATE INDEX`/`SET (fillfactor` in `post_operations` · `;` between
statements · `ADD PRIMARY KEY`/`ADD CONSTRAINT` in an incremental `post_operations` without
`when(!incremental())` · a bare `dataform`/`npm run` command.

On **`warehouse: mysql`**: a `postgres: {}`/`bigquery: {}` block · `defaultSchema` in creds ·
double-quoted identifiers in raw DDL (MySQL uses backticks) · a hand-added PK/unique just to make
an incremental `uniqueKey` work (auto-created) · `DELIMITER` around a procedure body · expecting
`materialized: true` to be a NATIVE matview (it's a refreshed table snapshot) · expecting
`description:`/`columns:` on a VIEW to produce comments (views can't; tables/incrementals do) ·
raw `CREATE FULLTEXT/SPATIAL INDEX` or `PARTITION BY` DDL in operations (first-class in
`mysql: {}` now) · `unique: true` with index `type: "fulltext"|"spatial"` (mutually exclusive).

When unsure of a `postgres:` field name or enum value, read `protos/configs.proto`.
