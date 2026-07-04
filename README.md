# SQLAnvil

**SQL workflow tool for BigQuery, Postgres, Supabase, and MySQL/MariaDB.**

SQLAnvil is an open-source fork of [Dataform OSS](https://github.com/dataform-co/dataform) (Apache 2.0), extended with first-class PostgreSQL and Supabase support, plus adapters for other data sources. Define your data transformations in SQLX, have SQLAnvil compile them to idiomatic SQL, and run them against your warehouse.

> **SQLAnvil is not affiliated with or endorsed by Google.** The Dataform name and related marks are trademarks of Google LLC. See [NOTICE](NOTICE) for attribution.

---

## Features

- **BigQuery** — full support: partitioning, clustering, labels, materialized views, `MERGE`-based incremental upserts
- **PostgreSQL** — idiomatic DDL: native partitioning, `INSERT ... ON CONFLICT` upserts, btree/gin/gist/brin indexes, tablespaces, fillfactor
- **Supabase** — extends Postgres with RLS policies, Realtime publications, pgvector indexes, and Supabase Wrappers _(coming soon)_
- **MySQL / MariaDB** — portable MySQL DDL: CTAS tables, `CREATE OR REPLACE VIEW`, `ON DUPLICATE KEY UPDATE` incremental upserts (one adapter, validated against both engines)
- **SQLX + YAML + JS** — three authoring modes: SQL with config blocks, `actions.yaml` bulk definitions, or the JavaScript API

---

## Quick start

```bash
npm install -g @sqlanvil/cli
sqlanvil init my-project
cd my-project
# edit workflow_settings.yaml to configure your warehouse
sqlanvil compile
sqlanvil run
```

**`workflow_settings.yaml` example (Postgres):**

```yaml
warehouse:
  kind: postgres
  host: localhost
  port: 5432
  database: analytics
  user: sqlanvil_writer
  password: ${PG_PASSWORD}
  ssl: disable
  defaultSchema: public
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

Full documentation at **[sqlanvil.com](https://sqlanvil.com)**.

- [Getting Started](https://sqlanvil.com/getting-started/)
- [BigQuery Guide](https://sqlanvil.com/guides/bigquery/)
- [PostgreSQL Guide](https://sqlanvil.com/guides/postgres/)
- [Supabase Guide](https://sqlanvil.com/guides/supabase/)
- [Configs Reference](https://sqlanvil.com/reference/configs/)

---

## Project layout

```
core/         Compiler + action types (table/view/incremental/assertion/operation/notebook/declaration)
cli/          CLI entrypoint and per-adapter glue (cli/api/dbadapters/)
protos/       Protobuf definitions for core/configs/execution/db_adapter
examples/     Sample SQLAnvil projects
scripts/      ./scripts/run is the CLI entrypoint wrapper
```

---

## Building from source

SQLAnvil uses [Bazel](https://bazel.build) (via Bazelisk). Native Bazel works on macOS
and Linux (Bazel 7 + bzlmod):

```bash
# Build the proto layer
bazel build //protos:sqlanvil_proto

# Run the CLI
./scripts/run help

# Run tests
bazel test //core/... //cli/...
```

A Docker-based build container (`./scripts/docker-bazel`) remains available as an
optional hermetic environment. See [contributing.md](contributing.md) for full instructions.

---

## Documentation

Reference docs and design documents live in the separate [`sqlanvil/docs`](https://github.com/sqlanvil/docs) repo, published at [sqlanvil.com/docs](https://sqlanvil.com/docs/).

---

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

SQLAnvil is a derivative of Dataform OSS (originally developed by Dataform Co and contributed to by Google LLC). It has been fully renamed and extended with first-class PostgreSQL/Supabase support. Licensed under Apache License 2.0.
