# sqlanvil

**sqlanvil** is an open-source SQL workflow tool. Define dependent tables, views, materialized views, incremental tables, assertions, and operations as code — then compile, test, and execute them against your warehouse.

sqlanvil is a hard fork of [Dataform](https://github.com/dataform-co/dataform) (Apache 2.0), renamed and restructured to support **PostgreSQL/Supabase** as a first-class target alongside **BigQuery**.

## Status

Pre-alpha. Active reintegration of the Postgres adapter is in progress on the
`restore-postgres-adapter` branch. See `docs/postgres_first_class_design.md`
for the implementation spec and `docs/rename_checklist.md` for the
dataform → sqlanvil rename surface.

## Supported warehouses

| Warehouse | Status |
| :--- | :--- |
| BigQuery | Working (inherited from upstream Dataform) |
| PostgreSQL | In progress — first-class native adapter |
| Supabase (PostgreSQL + RLS, Realtime, Wrappers, pgvector) | Planned |

## Quickstart (when published)

```bash
npm i -g @sqlanvil/cli
sqlanvil init my-project
cd my-project
sqlanvil compile
sqlanvil run
```

For now, building from source requires Bazel via Bazelisk
(`npm i -g @bazel/bazelisk`). See `contributing.md`.

## Attribution

sqlanvil derives from Dataform OSS by Dataform Co (acquired by Google).
The original code remains under the Apache 2.0 license. See `NOTICE` and
`LICENSE` for required attribution.
