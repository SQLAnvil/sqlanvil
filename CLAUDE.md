# CLAUDE.md

Guidance for Claude Code when working in the `sqlanvil/` project.

> **Writing a sqlanvil data *project*** (`.sqlx`, `workflow_settings.yaml`, `.df-credentials.json`
> for Postgres/Supabase) rather than hacking on this codebase? Follow [`AGENTS.md`](./AGENTS.md)
> (the cross-agent authoring guide) / the `sqlanvil-engineering-fundamentals` skill — it corrects
> the Dataform/BigQuery priors that otherwise produce broken sqlanvil code. This file is for work
> on the sqlanvil **codebase** (TypeScript, Bazel, protos).

## What This Is

**sqlanvil** is Ivan's fork of [`dataform-co/dataform`](https://github.com/dataform-co/dataform), fully renamed and repositioned as an open-source SQL workflow tool with first-class support for **BigQuery, PostgreSQL, and Supabase** (upstream Dataform OSS dropped Postgres support after the Google acquisition).

- **Upstream**: `git@github.com:dataform-co/dataform.git` (Google's Dataform OSS — low activity; focus shifted to hosted BigQuery product)
- **Origin**: `git@github.com:sqlanvil/sqlanvil.git`
- **Marketing site**: sibling repo `../sqlanvil-com/` — static HTML on Vercel. (Vercel project/team IDs are in the gitignored `CLAUDE.local.md`.)

## Stack

- **Language**: TypeScript
- **Build**: Bazel (via Bazelisk) — old-style `WORKSPACE`, not `MODULE.bazel`
- **Protos**: protobuf (`protos/*.proto`) for core/configs/db_adapter/etc.
- **Target warehouses**: BigQuery, PostgreSQL, and Supabase — all three adapters landed on `main` and integration-verified
- **No npm `scripts`** in `package.json` — everything runs through Bazel.

## Layout

```
core/         Compiler + action types (table/view/incremental/assertion/operation/notebook/declaration)
cli/          CLI entrypoint (cli/index.ts) and per-adapter glue (cli/api/dbadapters/ — bigquery, postgres, supabase)
protos/       Protobuf definitions for core/configs/execution/db_adapter
tools/        Bazel rules + Postgres/Supabase docker test fixtures (tools/postgres/, tools/supabase/)
tests/        Integration specs (bigquery + postgres + supabase) against real warehouses
examples/     Sample SQLAnvil projects
scripts/      `./scripts/run` is the CLI entrypoint wrapper
```

## Common Commands

```bash
# One-time
npm i -g @bazel/bazelisk
sudo sysctl -w kern.maxfiles=65536   # Mac only — Bazel hits the default fd limit

# Run the CLI (`sqlanvil` binary)
./scripts/run help
./scripts/run compile path/to/project

# Tests
bazel test //...                     # everything
bazel test //core/...                # core only
bazel test //cli:index_test          # CLI integration (needs GCP creds — see contributing.md)
```

## Design Directive — Rename Is Mandatory

The rename from Dataform → SQLAnvil is complete in the implementation (proto packages, most internal references, CLI routing, and branding). A final documentation pass was performed to remove outdated statements.

Remaining references are intentional:
- Historical context and upstream links
- Legal attribution in NOTICE/README.md
- BigQuery documentation links in `configs.proto`

This satisfies the trademark requirement. No further code changes needed for rename.

## Design Directive — Postgres Is First-Class

The Postgres adapter is **not** a BigQuery adapter with translated SQL. It generates idiomatic Postgres DDL/DML. Typical sqlanvil users may never have touched BigQuery; they should never see BigQuery quirks like `CREATE PRIMARY KEY mykey NOT ENFORCED`, `OPTIONS(...)` table options, `PARTITION BY`/`CLUSTER BY` clauses, or BigQuery's `MERGE` dialect.

Two adapter variants ship:

- **`postgres`** — standard Postgres. Idiomatic DDL, `INSERT ... ON CONFLICT` for upserts, native `CREATE INDEX`, tablespaces, fillfactor, partitioning via `PARTITION BY RANGE/LIST/HASH`.
- **`supabase`** — extends `postgres` with Supabase-specific surface area: RLS policies in actions, `auth.users` references, Realtime publications, `pgvector` indexes, `pg_cron` scheduling, Supabase Wrappers (FDW) declarations.

Implications for the Antigravity reintegration doc: Phase 3 ("Interface Alignment") is **under-scoped**. It frames the work as making the restored adapter implement BigQuery's `IDbAdapter` interface. Real work also includes:

- Postgres-specific action config blocks (e.g., `postgres: { tablespace, fillfactor, indexes, partition }` parallel to the existing `bigquery: { partitionBy, clusterBy, ... }`).
- A separate Postgres SQL generator path in `core/compilation_sql/` rather than reusing BigQuery's.
- Config schema additions in `protos/configs.proto` for both variants.

## Status — Postgres & Supabase Adapters (landed + integration-verified)

Both adapters are merged to `main` and **integration-verified** (2026-06-03): `//tests/integration:postgres.spec`, `:supabase.spec`, and `:supabase_rls.spec` pass against a local Docker Postgres + pgvector container — the last proves RLS is actually **enforced** (rows filtered for the `authenticated` role), not merely created. In place:

- **Adapters:** `cli/api/dbadapters/{postgres,supabase}.ts` + `{postgres,supabase}_execution_sql.ts` (Supabase extends Postgres). SQL gen so far: `create table`, `INSERT … ON CONFLICT` upsert, assertions.
- **Supabase action types** (`core/actions/`): `rls_policy`, `realtime_publication`, `wrapper`, `vector_index` — emit real DDL (`CREATE POLICY`, `ALTER PUBLICATION`, `CREATE FOREIGN TABLE`, vector index), unit-tested in `supabase_actions_test.ts`. RLS **enforcement** (a policy actually filtering rows by `auth.uid()`) is verified end-to-end in `tests/integration/supabase_rls.spec.ts`.
- **Config protos:** `PostgresOptions`, `SupabaseOptions`, and the nested `WarehouseConfig` / `{Postgres,Supabase,BigQuery}Connection` union in `protos/configs.proto`.
- **CLI:** `cli/index.ts` branches the adapter on `projectConfig.warehouse ∈ {bigquery, postgres, supabase}`; `credentials.ts` validates `PostgresConnection`.

**Remaining work** (authoritative plan: `postgres_first_class_design.md` in the [`sqlanvil/docs`](https://github.com/sqlanvil/docs) repo, §6):

1. **`PostgresOptions` DDL — generated.** ✅ Done (unit-tested in `cli/api/execution_sql_test.ts` + integration-tested in `tests/integration/postgres.spec.ts` against live Postgres): storage options (`unlogged`, `fillfactor`, `tablespace`); indexes (btree/hash/gin/gist/brin, `unique`, `INCLUDE`, partial `WHERE`, per-column **opclass**) for standard + incremental tables; **materialized views** (`view` + `materialized: true` → `CREATE MATERIALIZED VIEW`, drop+recreate each run); and native **partitioning** (RANGE/LIST/HASH) — bridged via a staging table (`CREATE UNLOGGED TABLE stage AS query WITH NO DATA` → `CREATE TABLE (LIKE stage) PARTITION BY …` → child partitions from `partition.partitions[]` bounds + optional DEFAULT → `INSERT … SELECT`), verified routing rows to the right child on real PG.

   **MV refinements also done**: `no_data` (→ `WITH NO DATA`) and `REFRESH`-on-rerun (opt in via `refresh_policy: "on_dependency_change"` — refreshes an existing matview in place instead of drop+recreate; default still drops+recreates, which also picks up definition changes). These are settable from a view's sqlx config: `ViewConfig` now carries a `postgres` block (field 22), wired in `core/actions/view.ts` and compile-tested in `core/actions/view_test.ts` — so `config { type: "view", materialized: true, postgres: { refreshPolicy, noData, indexes } }` flows through to the compiled `Table.postgres` the executor reads. This required teaching the adapter to **detect materialized views** — `table()`/`tables()` now union `pg_matviews`/`pg_attribute` since `information_schema` excludes matviews — and a `MATERIALIZED_VIEW` value on the `TableMetadata.Type` proto enum. All integration-tested on live PG (adapter detection, in-place refresh via oid stability, unpopulated `WITH NO DATA`).

   `#1 is effectively complete.` Remaining nice-to-have: opclasses on partitioned indexes. (Tablespace on partitioned parents + sub-partitioning landed in #21; fillfactor on a partitioned parent is invalid in Postgres, so it's not a gap.)
2. **`warehouse:` config shape — settled as FLAT (✅).** `workflow_settings.yaml` uses a flat `warehouse:` string (`bigquery`/`postgres`/`supabase`) + flat defaults; the connection (with secrets) stays in the gitignored `.df-credentials.json` (`PostgresConnection` shape). The design doc's earlier "nested `warehouse: { kind, connection }`" decision was overturned (it would have put secrets in committed config) — see `postgres_first_class_design.md` §8.2. Unknown `warehouse:` values are now rejected in `workflowSettingsAsProjectConfig` (unit-tested in `core/main_test.ts`) instead of silently defaulting to BigQuery. The proto `WarehouseConfig`/`*Connection` union remains the `.df-credentials.json` shape, not a workflow_settings block.
3. **Generator location — reconciled (✅).** Execution-time SQL gen lives in `cli/api/dbadapters/*_execution_sql.ts` (implementing `IExecutionSql`, parallel to `bigquery_execution_sql.ts`); `core/compilation_sql/` keeps only compile-time/warehouse-agnostic SQL. This is the intended layout — the design doc's earlier `core/compilation_sql/postgres/` location was corrected (see `postgres_first_class_design.md` §2 as-built note); no code relocation needed.

**Run the integration tests** — `./tools/postgres/run-postgres-db.sh` boots a Postgres+pgvector container; tests run *inside* the `docker-bazel` container so connect via `host.docker.internal` and pass env with `--test_env` (the `:postgres.spec`/`:supabase.spec` targets are runnable; the `*_tests` suffixes are compile-only macros):

```bash
PG_HOST=host.docker.internal PG_PORT=5432 PG_USER=postgres PG_PASSWORD=password PG_DATABASE=postgres \
  ./scripts/docker-bazel test //tests/integration:postgres.spec \
  --test_env=PG_HOST --test_env=PG_PORT --test_env=PG_USER --test_env=PG_PASSWORD --test_env=PG_DATABASE \
  --jobs=2 --local_ram_resources=2048
```

The same pattern runs `:supabase.spec` / `:supabase_rls.spec` with `SUPABASE_*` env (the bare-PG container is enough — the RLS spec seeds the auth primitives itself). For high-fidelity Supabase testing (real `anon`/`authenticated`/`service_role`, `auth` schema, Realtime), `./tools/supabase/run-supabase-stack.sh` boots the full local Supabase stack via the Supabase CLI on port 54322 and prints the matching test command.

## Nice-to-haves / roadmap

- **`sqlanvil validate` — feature complete (all four warehouses, live-verified).** Postgres/Supabase/MySQL via `EXPLAIN`, BigQuery via dry-run + a shadow *dataset* of `LIMIT 0` stub tables. Integration-tested on real Postgres, MySQL, **and live BigQuery** (`tests/integration/bigquery.spec.ts` validate suite, project `sqlanvil`). One small known gap: the **orphan-shadow sweep is a no-op on BigQuery** — `listSchemas` uses an unqualified `information_schema.schemata`, which BQ rejects (needs `` `project`.INFORMATION_SCHEMA.SCHEMATA ``); the sweep is best-effort/caught, and each run still drops its own shadow in `finally`, so this only matters for hard-killed BQ runs. Design + plan: `sqlanvil-private/planning/{specs,plans}/2026-06-24-validate-command-*`.

## Fork Hygiene

- Upstream changes still merge in cleanly today; the longer Ivan diverges (renames, Postgres adapter, future Supabase-specific features), the harder this gets. When pulling upstream, prefer rebasing feature branches onto `upstream/main` over merge commits to keep the history readable.
- The rename sweep (`rename/dataform-to-sqlanvil`) is complete. Future upstream merges should be straightforward.

## Things To Know

- **`sqlanvil validate`** (Postgres/Supabase/MySQL via `EXPLAIN`, + BigQuery via dry-run) walks the compiled DAG in topological order and validates each model against the warehouse planner (`EXPLAIN`) without executing. It compiles into a timestamped shadow namespace (a validation `schemaSuffix` composed onto the project/env suffix) and, after each model passes, materializes an **empty** stub (`CREATE TABLE … WITH NO DATA` on Postgres; wrapped `LIMIT 0` on MySQL; views via `CREATE VIEW`) so downstream `${ref()}`s resolve; the shadow schema(s)/database(s) are dropped in a `finally`. Per-action result is **PASS / FAILURE / BLOCKED** (a model whose only problem is an upstream failure) **/ SKIPPED** (operations — not validated); any FAILURE or BLOCKED exits non-zero. Code: `cli/api/commands/validate.ts` (orchestrator) + `validate_graph.ts` (topo + classification), builders on each `*_execution_sql.ts` (`validationStubSql`/`createSchemaSql`/`dropSchemaCascadeSql`), CLI in `cli/index.ts` (the `runValidate` helper backs both the `validate` command and the `run --dry-run` alias). **`run --dry-run` on Postgres/Supabase/MySQL now validates instead of executing** — previously it was a no-op that still applied changes while printing "no changes". BigQuery keeps its native server-side dry-run on `run --dry-run`; the `validate` *command* additionally supports BigQuery (shadow dataset of `LIMIT 0` stubs), live-verified against project `sqlanvil` (see Nice-to-haves for the BQ sweep caveat). Each run first **sweeps orphaned shadows** — `*sqlanvil_validate_<ts>` schemas/databases older than 1h, left by killed runs (`sweepOrphanShadows`, matched by the `sqlanvil_validate_` marker so real schemas are never touched).
- **Metadata** (`description:` + `columns: {}` in a sqlx `config`) is fully supported on Postgres: compiled into the action descriptor (unit-tested in `core/actions/*_test.ts`), applied via `setMetadata` → `COMMENT ON TABLE|VIEW|MATERIALIZED VIEW … IS …` + `COMMENT ON COLUMN …` (single-quotes escaped), and read back through `table()` via `pg_description`. Integration-tested in `postgres.spec` for **tables, incremental tables, views, and materialized views** (matviews need `COMMENT ON MATERIALIZED VIEW`, keyed off the resolved metadata type — `COMMENT ON VIEW` errors on a matview).
- **Auto-assertions** from `config { assertions: { uniqueKey / uniqueKeys / nonNull / rowConditions } }` work on Postgres: the compiler (`core/actions/base.ts`) generates one assertion action per `uniqueKey` — `uniqueKey` (single key, single/multi-column) or `uniqueKeys` (one or more keys, each single/multi-column) — plus `nonNull`/`rowConditions`. The uniqueness SQL (`compilation_sql/index.ts` `indexAssertion`) double-quotes columns for postgres/supabase. Integration-tested in `postgres.spec` (single-column dup → assertion FAILS; multi-column + single-column unique keys → PASS).
- **pre_operations / post_operations** run before/after a table build on Postgres. For incremental tables the adapter selects `preOps`/`postOps` on create + full-refresh and `incrementalPreOps`/`incrementalPostOps` on incremental **appends** (`postgres_execution_sql.ts`, `shouldWriteIncrementally`). **Gotcha (verified end-to-end via `examples/postgres_shop`):** the compiler evaluates a single `post_operations` block in *both* contexts (`incremental_table.ts:602-612`), so an **unwrapped** op lands in both `postOps` *and* `incrementalPostOps` and runs on every append — a bare `ALTER TABLE … ADD PRIMARY KEY` then errors with "multiple primary keys". One-time DDL must be wrapped in `${when(!incremental(), \`…\`)}` so it only lands in the create-path ops. Caveat: on a **materialized view** post-ops re-run after every build, including an opt-in `REFRESH`, so keep matview post-ops idempotent (Postgres matviews can't have PKs/constraints anyway).
- **Operations** (`type: "operations"`) run arbitrary SQL and work on Postgres (the task generator is dialect-agnostic) — so stored **procedures/functions** (`CREATE PROCEDURE/FUNCTION`, `CALL`), triggers, `CREATE EXTENSION`, `GRANT`, etc. are all expressible via operations (no dedicated action type). sqlx splits operation statements on `---`, not `;`, so PL/pgSQL `$$ … ; … $$` bodies survive. Verified in `postgres.spec` ("operations run a stored PROCEDURE with a $$ body").
- The legacy root `api/` directory is **gone** — all adapter code lives under `cli/api/dbadapters/`. (The old reintegration assessment doc references `api/`; that relocation is done.)
- Integration tests need real warehouses: BigQuery creds in `test_credentials/bigquery.json` (a `{projectId, location, credentials}` wrapper, not a raw key — see contributing.md); Postgres/Supabase via the Docker container from `./tools/postgres/run-postgres-db.sh`, reached as `host.docker.internal` from inside `docker-bazel`.
- Rename audit (performed via grep): No active `@dataform/*` imports or `dataform.*` proto usages remain in code. All critical paths use `sqlanvil`. Remaining mentions are docs/comments/links.
