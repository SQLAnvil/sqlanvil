# postgres_shop — sqlanvil on PostgreSQL

A small but complete sqlanvil project targeting **PostgreSQL/Supabase**. It is the runnable
companion to the `sqlanvil-engineering-fundamentals` skill / [`AGENTS.md`](../../AGENTS.md): every
file demonstrates a Postgres-first pattern, and the whole DAG seeds itself from `VALUES` so it runs
on a bare Postgres with no external sources.

## What it shows

| File | Pattern |
|---|---|
| `workflow_settings.yaml` | `warehouse: postgres`, `defaultDataset` = schema (no BigQuery keys) |
| `.df-credentials.json` | flat `PostgresConnection` (no comment keys — the parser is strict) |
| `definitions/raw_orders.sqlx` | `postgres: { fillfactor, indexes }` storage options on a table |
| `definitions/dim_customers.sqlx` | `description` + `columns` comments, `assertions: { uniqueKey }`, unique index |
| `definitions/stg_orders.sqlx` | `${ref()}` dependencies |
| `definitions/fct_daily_revenue.sqlx` | `incremental` with `uniqueKey` (upsert) + one-time PK via `when(!incremental())` |
| `definitions/v_top_customers.sqlx` | view |
| `definitions/mv_revenue_rollup.sqlx` | materialized view with `postgres: { refreshPolicy, indexes }` (in-place REFRESH) |
| `definitions/assert_revenue_non_negative.sqlx` | standalone `type: "assertion"` |
| `definitions/fn_total_revenue.sqlx` | `type: "operations"` function + `CALL`, `---` separator, `$$` body |

## Verify

Compilation is gated by `//examples:examples_test` (the same harness as the other examples):

```bash
./scripts/docker-bazel test //examples:examples_test --jobs=2 --local_ram_resources=2048
```

To run it end-to-end against a local Postgres:

```bash
./tools/postgres/run-postgres-db.sh          # boots Postgres on localhost:5432 (postgres/password)
./scripts/run run examples/postgres_shop --credentials examples/postgres_shop/.df-credentials.json
```

Re-running is safe: `fct_daily_revenue` appends incrementally and `mv_revenue_rollup` refreshes in
place — the PK is added only on create because it's wrapped in `when(!incremental())`.
