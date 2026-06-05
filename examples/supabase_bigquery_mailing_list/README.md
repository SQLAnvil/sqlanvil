# Supabase + BigQuery: proximity mailing list

A live **cross-warehouse** SQLAnvil example. It builds a mailing list of customers
who purchased in the last year **and** live within a radius of a target ZIP code —
joining operational e-commerce data in **Supabase** with Google's
**`bigquery-public-data.geo_us_boundaries.zip_codes`** geo data, queried in place
through a BigQuery Foreign Data Wrapper. No ETL job, no second pipeline: one
`sqlanvil run`.

## How it works

```
bigquery-public-data.geo_us_boundaries.zip_codes
        │  (live FDW query)
        ▼
zip_codes (foreign table, ref-able)        ← created by the wrapper() action
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

`definitions/sources/bigquery_zip_codes.js` declares the whole BigQuery bridge in a
single `wrapper()` call: it enables the `wrappers` extension, registers the BigQuery
FDW + server, and exposes `zip_codes` as a `ref()`-able foreign table. Everything
downstream is plain Supabase/Postgres SQL.

## Prerequisites

- A **Supabase project** with the `wrappers` and `postgis` extensions enabled
  (Dashboard → Database → Extensions).
- A **GCP service account** with a billing-enabled project and BigQuery read access.
  Querying public datasets is free up to the monthly tier, but BigQuery still needs
  a billing project to run the query.
- `@sqlanvil/cli` (`npm i -g @sqlanvil/cli`).

> The BigQuery wrapper relies on Supabase's `wrappers` extension. It works on
> Supabase (or self-managed Postgres where you've installed `wrappers`), **not** on
> managed Postgres like RDS/Cloud SQL out of the box.

## One-time: store the service-account key in Vault

The wrapper references the SA key by a Vault secret **id** — the key JSON itself
never lives in this repo. Create the secret once in the Supabase SQL editor:

```sql
-- Paste your service-account JSON. Returns the secret id.
select vault.create_secret('<paste service-account JSON>', 'bigquery_sa');

-- Read the id back:
select id from vault.secrets where name = 'bigquery_sa';
```

Copy the returned id into `workflow_settings.yaml` → `vars.bq_sa_key_id`.

## Configure

```bash
cp .df-credentials.example.json .df-credentials.json
# Fill in the Supabase Session pooler connection (host verbatim from the
# dashboard Connect dialog; user = postgres.<project-ref>; sslMode require).
```

Set `vars.bq_sa_key_id` in `workflow_settings.yaml` to the Vault secret id from above.

## Run

```bash
sqlanvil run examples/supabase_bigquery_mailing_list --credentials examples/supabase_bigquery_mailing_list/.df-credentials.json
```

This creates the FDW bridge, materializes the zip centroids, seeds the sample
operational tables, and lands `public.mailing_list`.

## Tune the audience

Change the target and radius (and recency window) in `workflow_settings.yaml`:

```yaml
vars:
  target_zip: "94110"          # the ZIP to measure distance from
  radius_miles: "25"           # include customers within this many miles
  purchased_since_days: "365"  # only customers who ordered in this window
```

## What's in here

| Path | Purpose |
|------|---------|
| `definitions/sources/bigquery_zip_codes.js` | BigQuery FDW + `ref()`-able `zip_codes` foreign table |
| `definitions/staging/stg_zip_codes.sqlx` | Shaped view over the live foreign table |
| `definitions/staging/zip_codes_cache.sqlx` | Materializes BigQuery zip centroids into Supabase |
| `definitions/operational/*.sqlx` | Sample `customers` + `sales_orders` |
| `definitions/marts/mailing_list*.sqlx` | Join + PostGIS distance → final mailing list |
| `definitions/assertions/*.sqlx` | Data-quality checks (non-null email, non-negative distance) |
