# CLAUDE.md

Guidance for Claude Code when working in the `sqlanvil/` project.

## What This Is

**sqlanvil** is Ivan's fork of [`dataform-co/dataform`](https://github.com/dataform-co/dataform), fully renamed and repositioned as an open-source SQL workflow tool with first-class support for **BigQuery, PostgreSQL, and Supabase** (upstream Dataform OSS dropped Postgres support after the Google acquisition).

- **Upstream**: `git@github.com:dataform-co/dataform.git` (Google's Dataform OSS — low activity; focus shifted to hosted BigQuery product)
- **Origin**: `git@github.com:sqlanvil/sqlanvil.git`
- **Marketing site**: sibling repo `../sqlanvil-com/` — static HTML on Vercel (project: `sqlanvil-com`, team `Zlu36JPJdwPqwMeAWAqISllx`)

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
- Legal attribution in NOTICE/readme.md
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

1. **`PostgresOptions` DDL — mostly generated.** ✅ Done (unit-tested in `cli/api/execution_sql_test.ts` + integration-tested in `tests/integration/postgres.spec.ts` against live Postgres): storage options (`unlogged`, `fillfactor`, `tablespace`); indexes (btree/hash/gin/gist/brin, `unique`, `INCLUDE`, partial `WHERE`, per-column **opclass** e.g. `gin_trgm_ops`/`jsonb_path_ops`) for standard + incremental tables; and **materialized views** (`view` + `materialized: true` → `CREATE MATERIALIZED VIEW`, drop+recreate each run). Still TODO: native **partitioning** (needs CTAS rework — `CREATE TABLE AS` can't `PARTITION BY`, and partition bounds aren't in the config yet); and **MV refinements** — `WITH NO DATA` (blocked by `with_data` proto3 default-false; needs a proto tweak) and `REFRESH`-on-rerun instead of recreate.
2. **Nested `warehouse:` config (§8.2) parser not wired** — the proto union and the credentials file use it, but `workflow_settings.yaml` parsing is still flat (`warehouse:` string + `defaultProject`/`defaultDataset`).
3. **Generator location drift** — SQL gen lives in `cli/api/dbadapters/*_execution_sql.ts`, not `core/compilation_sql/postgres/` as the design doc specifies; reconcile doc or relocate.

**Run the integration tests** — `./tools/postgres/run-postgres-db.sh` boots a Postgres+pgvector container; tests run *inside* the `docker-bazel` container so connect via `host.docker.internal` and pass env with `--test_env` (the `:postgres.spec`/`:supabase.spec` targets are runnable; the `*_tests` suffixes are compile-only macros):

```bash
PG_HOST=host.docker.internal PG_PORT=5432 PG_USER=postgres PG_PASSWORD=password PG_DATABASE=postgres \
  ./scripts/docker-bazel test //tests/integration:postgres.spec \
  --test_env=PG_HOST --test_env=PG_PORT --test_env=PG_USER --test_env=PG_PASSWORD --test_env=PG_DATABASE \
  --jobs=2 --local_ram_resources=2048
```

The same pattern runs `:supabase.spec` / `:supabase_rls.spec` with `SUPABASE_*` env (the bare-PG container is enough — the RLS spec seeds the auth primitives itself). For high-fidelity Supabase testing (real `anon`/`authenticated`/`service_role`, `auth` schema, Realtime), `./tools/supabase/run-supabase-stack.sh` boots the full local Supabase stack via the Supabase CLI on port 54322 and prints the matching test command.

## Fork Hygiene

- Upstream changes still merge in cleanly today; the longer Ivan diverges (renames, Postgres adapter, future Supabase-specific features), the harder this gets. When pulling upstream, prefer rebasing feature branches onto `upstream/main` over merge commits to keep the history readable.
- The rename sweep (`rename/dataform-to-sqlanvil`) is complete. Future upstream merges should be straightforward.

## Things To Know

- The legacy root `api/` directory is **gone** — all adapter code lives under `cli/api/dbadapters/`. (The old reintegration assessment doc references `api/`; that relocation is done.)
- Integration tests need real warehouses: BigQuery creds in `test_credentials/bigquery.json` (a `{projectId, location, credentials}` wrapper, not a raw key — see contributing.md); Postgres/Supabase via the Docker container from `./tools/postgres/run-postgres-db.sh`, reached as `host.docker.internal` from inside `docker-bazel`.
- Rename audit (performed via grep): No active `@dataform/*` imports or `dataform.*` proto usages remain in code. All critical paths use `sqlanvil`. Remaining mentions are docs/comments/links.
