# CLAUDE.md

Guidance for Claude Code when working in the `sqlanvil/` project.

## What This Is

**sqlanvil** is Ivan's fork of [`dataform-co/dataform`](https://github.com/dataform-co/dataform), renamed and being repositioned as an open-source SQL workflow tool that runs against **both BigQuery and PostgreSQL/Supabase** (upstream Dataform OSS dropped Postgres support some time ago).

- **Upstream**: `git@github.com:dataform-co/dataform.git` (Google's Dataform OSS — low activity since GA in BigQuery)
- **Origin**: `git@github.com:sqlanvil/sqlanvil.git`
- **Marketing site**: sibling repo `../sqlanvil-com/` — static HTML on Vercel (project: `sqlanvil-com`, team `Zlu36JPJdwPqwMeAWAqISllx`)

## Stack

- **Language**: TypeScript
- **Build**: Bazel (via Bazelisk) — old-style `WORKSPACE`, not `MODULE.bazel`
- **Protos**: protobuf (`protos/*.proto`) for core/configs/db_adapter/etc.
- **Target warehouses**: BigQuery (working), PostgreSQL (being reintegrated)
- **No npm `scripts`** in `package.json` — everything runs through Bazel.

## Layout

```
core/         Compiler + action types (table/view/incremental/assertion/operation/notebook/declaration)
cli/          CLI entrypoint (cli/index.ts) and per-adapter glue (cli/api/dbadapters/)
protos/       Protobuf definitions for core/configs/execution/db_adapter
api/          Legacy directory — currently holds restored Postgres adapter files awaiting relocation
tools/        Bazel rules + the Postgres docker test fixture (tools/postgres/postgres_fixture.ts)
tests/        Integration specs (bigquery + postgres) against real warehouses
examples/     Sample Dataform projects
scripts/      `./scripts/run` is the CLI entrypoint wrapper
```

## Common Commands

```bash
# One-time
npm i -g @bazel/bazelisk
sudo sysctl -w kern.maxfiles=65536   # Mac only — Bazel hits the default fd limit

# Run the CLI (substitute for `dataform` from @dataform/cli)
./scripts/run help
./scripts/run compile path/to/project

# Tests
bazel test //...                     # everything
bazel test //core/...                # core only
bazel test //cli:index_test          # CLI integration (needs GCP creds — see contributing.md)
```

## Design Directive — Rename Is Mandatory

The fork must be fully renamed from `dataform` → `sqlanvil` before public-facing artifacts (npm packages, CLI binary, docs site, marketing) ship. Reason: avoid trademark conflict with Google's "Dataform" product. Scope of rename:

- Proto package names (`dataform.*` → `sqlanvil.*`)
- npm package names (`@dataform/*` → `@sqlanvil/*` or unscoped `sqlanvil-*`)
- CLI binary (`dataform` → `sqlanvil`)
- Config files (`dataform.json` → `sqlanvil.json`, `workflow_settings.yaml` keys)
- Internal class names referencing `Dataform`
- Docs site references

The rename is a hard prerequisite, not nice-to-have. Sequence it before — or in parallel with — the Postgres adapter work.

## Design Directive — Postgres Is First-Class

The Postgres adapter is **not** a BigQuery adapter with translated SQL. It generates idiomatic Postgres DDL/DML. Typical sqlanvil users may never have touched BigQuery; they should never see BigQuery quirks like `CREATE PRIMARY KEY mykey NOT ENFORCED`, `OPTIONS(...)` table options, `PARTITION BY`/`CLUSTER BY` clauses, or BigQuery's `MERGE` dialect.

Two adapter variants ship:

- **`postgres`** — standard Postgres. Idiomatic DDL, `INSERT ... ON CONFLICT` for upserts, native `CREATE INDEX`, tablespaces, fillfactor, partitioning via `PARTITION BY RANGE/LIST/HASH`.
- **`supabase`** — extends `postgres` with Supabase-specific surface area: RLS policies in actions, `auth.users` references, Realtime publications, `pgvector` indexes, `pg_cron` scheduling, Supabase Wrappers (FDW) declarations.

Implications for the Antigravity reintegration doc: Phase 3 ("Interface Alignment") is **under-scoped**. It frames the work as making the restored adapter implement BigQuery's `IDbAdapter` interface. Real work also includes:

- Postgres-specific action config blocks (e.g., `postgres: { tablespace, fillfactor, indexes, partition }` parallel to the existing `bigquery: { partitionBy, clusterBy, ... }`).
- A separate Postgres SQL generator path in `core/compilation_sql/` rather than reusing BigQuery's.
- Config schema additions in `protos/configs.proto` for both variants.

## Active Work — Postgres Reintegration

Current branch: `restore-postgres-adapter`. Recent commits (Ivan's, on top of upstream):

1. `a220e2ed` — restored the Postgres adapter files from git history into `api/dbadapters/postgres.ts` and `api/utils/postgres.ts` (won't compile as-is)
2. `fcca60c1` — added `docs/postgres_reintegration_assessment.md` (Antigravity)
3. `1636e275` — added `docs/hybrid_warehouses_supabase_bigquery.md` (Antigravity)

The two new design docs are Antigravity-authored and **load-bearing for the next sprint**. They now live in the separate [`sqlanvil/docs`](https://github.com/sqlanvil/docs) repo (moved out of this monorepo):

- **`postgres_reintegration_assessment.md`** — 5-phase, ~1-2 day plan to make the restored adapter compile and wire into the CLI. Phases: deps (`pg`, `pg-query-stream`) → relocate `api/` → `cli/api/` → align `IDbAdapter` interface (implement `executeRaw`, `deleteTable`, full `ITableMetadata`) → branch CLI on `projectConfig.warehouse === "postgres"` → Bazel/docker fixture verification.
- **`hybrid_warehouses_supabase_bigquery.md`** — marketing/architecture doc: three patterns for combining Supabase + BigQuery (federated queries, sequential pipeline, Supabase Wrappers / FDW). Reference material, no implementation required.

When working on Postgres reintegration, **follow the assessment doc's phase order** — deps before relocation before interface work — because each phase's tests depend on the previous one passing through Bazel.

## Fork Hygiene

- Upstream changes still merge in cleanly today; the longer Ivan diverges (renames, Postgres adapter, future Supabase-specific features), the harder this gets. When pulling upstream, prefer rebasing feature branches onto `upstream/main` over merge commits to keep the history readable.
- Renaming Dataform → sqlanvil should be done in one sweep (package names, proto packages, CLI binary, docs) rather than incrementally — partial renames create grep ambiguity.

## Things To Know

- The `api/` directory at the repo root is **legacy**. The active CLI/adapter layout lives under `cli/api/`. Restored Postgres files are in the legacy location and need to move (see Phase 2 of the assessment doc).
- Integration tests need real warehouses: BigQuery creds in `test_credentials/bigquery.json`, Postgres via Docker container started by `tools/postgres/postgres_fixture.ts` inside the Bazel sandbox.
- The fork still references `@dataform/...` in many places — rename surface area is large.
