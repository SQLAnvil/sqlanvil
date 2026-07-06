# SQLAnvil

**SQL workflow tool for BigQuery, Postgres, Supabase, and MySQL/MariaDB.**

SQLAnvil is an open-source fork of [Dataform OSS](https://github.com/dataform-co/dataform) (Apache 2.0), extended with first-class PostgreSQL, Supabase, and MySQL/MariaDB support. Define your data transformations in SQLX, have SQLAnvil compile them to idiomatic SQL for your warehouse, and run, validate, and document the whole DAG from one CLI.

> **SQLAnvil is not affiliated with or endorsed by Google.** The Dataform name and related marks are trademarks of Google LLC. See [NOTICE](NOTICE) for attribution.

---

## Features

**Four first-class warehouses** — each adapter generates its warehouse's own idiomatic SQL, not translated BigQuery:

- **PostgreSQL** — native partitioning (RANGE/LIST/HASH), `INSERT … ON CONFLICT` upserts, btree/hash/gin/gist/brin indexes (unique, partial, `INCLUDE`, opclasses), tablespaces, fillfactor, materialized views with in-place refresh policies
- **Supabase** — everything Postgres, plus RLS policies, Realtime publications, pgvector indexes, and Supabase Wrappers (FDW) as declarative actions
- **MySQL / MariaDB** — one adapter validated against both engines: CTAS tables, `ON DUPLICATE KEY UPDATE` incremental upserts, the full `mysql: {}` config block (engine/charset/collation/rowFormat, secondary indexes incl. `FULLTEXT`/`SPATIAL` and prefix lengths, native partitioning), materialized-view emulation
- **BigQuery** — full upstream support: partitioning, clustering, labels, materialized views, `MERGE`-based incremental upserts

**Beyond transformation** — the pieces most SQL workflow tools leave outside the pipeline:

- **Cross-warehouse sources** — read BigQuery or MySQL/MariaDB from a Postgres/Supabase warehouse via named `connections:`: a live FDW bridge (Supabase Wrappers) or **runner-extract** (the CLI reads the source at run time and materializes a plain `ref()`-able table — keyless BigQuery supported). `sqlanvil introspect` scaffolds the declarations
- **File imports & exports** — `type: "import"` loads Parquet/CSV/JSON from `s3://`/`gs://`/local into a `ref()`-able table (DuckDB bridge on Postgres/Supabase, native `LOAD DATA` on BigQuery); `type: "export"` writes query results back out to files
- **Python script actions** — `python:` in `actions.yaml` runs file-staging and glue scripts as first-class DAG nodes: ordered by dependencies, covered by run history, no warehouse credentials injected (scripts stage files; `import` loads them). SQLAnvil validates the declared environment — interpreter version, `requirements.txt` vs installed packages, syntax — and never installs anything
- **`sqlanvil validate`** — EXPLAIN/dry-run the *whole DAG* against the live warehouse without executing: an isolated shadow schema of empty stubs lets every downstream `ref()` resolve; results classify as PASS / FAIL / BLOCKED so one real error doesn't cascade
- **Queryable artifacts** — every compile/run writes a Parquet catalog + run history under `target/`; `sqlanvil query` runs SQL over them, `sqlanvil inspect` summarizes, `sqlanvil docs` renders a self-contained HTML catalog
- **Release-artifact runs** — `sqlanvil run --graph <file>` executes a stored `compile --json` output exactly as compiled; **named environments** (`--environment`) give per-env schema suffixes and vars
- **SQLX + YAML + JS** — three authoring modes: SQL with config blocks, `actions.yaml` bulk definitions, or the JavaScript API

Want hosted orchestration on top (branch-aware CI on PRs, scheduled workflows, zero credential custody)? That's **[SQLAnvil Cloud](https://sqlanvil.com/docs/cloud/)**.

---

## Quick start

```bash
npm install -g @sqlanvil/cli
sqlanvil init my-project
cd my-project
# edit workflow_settings.yaml + .df-credentials.json (see below)
sqlanvil compile
sqlanvil run
```

**`workflow_settings.yaml` (Postgres/Supabase):** the warehouse is a flat string; connection
secrets never live here.

```yaml
warehouse: postgres            # bigquery | postgres | supabase | mysql
defaultDataset: public         # the Postgres schema
defaultAssertionDataset: sqlanvil_assertions
sqlanvilCoreVersion: 1.20.1
```

**`.df-credentials.json`** (gitignored) holds the connection:

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "analytics",
  "user": "sqlanvil_writer",
  "password": "...",
  "sslMode": "disable"
}
```

**First action (`definitions/my_view.sqlx`):**

```sql
config {
  type: "view",
  description: "My first SQLAnvil view."
}

SELECT 1 AS id, 'hello' AS greeting
```

---

## Documentation

Full documentation at **[sqlanvil.com/docs](https://sqlanvil.com/docs/)**.

- [Getting Started](https://sqlanvil.com/docs/getting-started/)
- Warehouses: [PostgreSQL](https://sqlanvil.com/docs/guides/postgres/) · [Supabase](https://sqlanvil.com/docs/guides/supabase/) · [MySQL/MariaDB](https://sqlanvil.com/docs/guides/mysql/) · [BigQuery](https://sqlanvil.com/docs/guides/bigquery/)
- [Cross-warehouse sources](https://sqlanvil.com/docs/guides/foreign-wrappers/) · [File Imports](https://sqlanvil.com/docs/guides/imports/) · [File Exports](https://sqlanvil.com/docs/guides/exports/) · [Python Script Actions](https://sqlanvil.com/docs/guides/python-actions/)
- [Validate](https://sqlanvil.com/docs/guides/validate/) · [Named Environments](https://sqlanvil.com/docs/guides/environments/) · [Artifacts & Catalog](https://sqlanvil.com/docs/guides/artifacts/)
- [Configs Reference](https://sqlanvil.com/docs/reference/configs/) · [What's New](https://sqlanvil.com/docs/whats-new/)

Writing sqlanvil projects with an AI agent? Point it at [`AGENTS.md`](AGENTS.md) — it corrects
the Dataform/BigQuery priors that otherwise produce broken sqlanvil code. Contributor/design
docs live in the separate [`sqlanvil/docs`](https://github.com/sqlanvil/docs) repo.

---

## Project layout

```
core/         Compiler + action types (table/view/incremental/assertion/operation/declaration/import/export/script/…)
cli/          CLI entrypoint and per-adapter glue (cli/api/dbadapters/ — bigquery, postgres, supabase, mysql)
protos/       Protobuf definitions for core/configs/execution/db_adapter
tests/        Integration specs against real warehouses (Postgres, Supabase, MySQL/MariaDB, BigQuery)
tools/        Bazel rules + Docker fixtures for the integration databases
examples/     Sample SQLAnvil projects (see examples/supabase_bigquery_mailing_list)
scripts/      ./scripts/run is the CLI entrypoint wrapper
```

---

## Building from source

SQLAnvil uses [Bazel](https://bazel.build) 7 with bzlmod (via Bazelisk). Native Bazel works on
macOS and Linux:

```bash
# Run the CLI
./scripts/run help

# Run tests
bazel test //core/... //cli/...

# Integration tests against a local Docker Postgres
./tools/postgres/run-postgres-db.sh
```

A Docker-based build container (`./scripts/docker-bazel`) remains available as an optional
hermetic environment. See [contributing.md](contributing.md) for full instructions.

---

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

SQLAnvil is a derivative of Dataform OSS (originally developed by Dataform Co and contributed to by Google LLC). It has been fully renamed and extended with first-class PostgreSQL/Supabase/MySQL support. Licensed under Apache License 2.0.
