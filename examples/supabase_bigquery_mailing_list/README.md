# Supabase + BigQuery: proximity mailing list

A live **cross-warehouse** SQLAnvil example. It builds a mailing list of customers
who purchased in the last year **and** live within a radius of a target ZIP code —
joining operational e-commerce data in **Supabase** with Google's
**`bigquery-public-data.geo_us_boundaries.zip_codes`** geo data (queried in place
through a BigQuery Foreign Data Wrapper) and **OpenAddresses.io** address points
(loaded from a file through the DuckDB import bridge) for address-level distance.
No ETL job, no second pipeline: one `sqlanvil run`.

## How it works

```
bigquery-public-data.geo_us_boundaries.zip_codes        data/openaddresses_sample.csv
        │  (live FDW query)                                     │  (type: "import" — DuckDB bridge)
        ▼                                                       ▼
bigquery_public_ext.zip_codes (foreign table)           oa_ext.openaddresses_us (table)
        │                                                       │
        ▼                                                       ▼
bq_ext.stg_zip_codes (view)                             oa_ext.stg_addresses (view: normalize + filter)
        │                                                       │
        ▼                                                       ▼
public.zip_codes_cache (table)                          public.addresses_cache (table, composite indexes)
        │                                                       │
public.customers ─┐                                             │
public.sales_orders ┼───────────────────►  public.mailing_list_candidates
                  │                        (view: geocode to address point, fall back
                  │                         to ZIP centroid, distance + filters)
                  ▼                                      │
                                                         ▼
                                           public.mailing_list (table)
```

The BigQuery source is declared as a **named connection** (`bigquery_public` in
`workflow_settings.yaml`) plus a one-line declaration in
`definitions/sources/zip_codes.sqlx`:

```js
config {
  type: "declaration",
  connection: "bigquery_public",
  name: "zip_codes",
  columnTypes: { zip_code: "text", internal_point_lat: "float8", internal_point_lon: "float8" }
}
```

From that, SQLAnvil **auto-generates the whole FDW bridge** at compile time — it
enables the `wrappers` extension, registers the BigQuery FDW + server
(`bigquery_public_srv`), and exposes a `ref()`-able foreign table
(`bigquery_public_ext.zip_codes`). No hand-written `wrapper()` action. Everything
downstream is plain Supabase/Postgres SQL.

The foreign table lands in an auto-named `bigquery_public_ext` schema
(`<connection>_ext`), keeping the external/foreign surface separate from your
operational `public` tables. The shaped staging view (`stg_zip_codes`) sits in
`bq_ext`; the materialized cache and marts land in `public`.

## Address-level accuracy with OpenAddresses (file import)

ZIP centroids are good; **exact address points are better**. This example layers in
[OpenAddresses.io](https://openaddresses.io) — the open dataset of hundreds of
millions of address points — so the distance filter uses the customer's *actual
address* whenever it geocodes, and only falls back to the ZIP centroid when it
doesn't. The mart's `precision` column tells you which one each row used.

The ingestion is a two-step, fully in-DAG chain — the slot Dataform/dbt leave outside
the pipeline:

1. **A `python:` script action** (`definitions/actions.yaml` → `loader/fetch_openaddresses.py`)
   stages the file. Out of the box it re-stages the bundled sample (dropping rows with broken
   coordinates at the edge); set an `oa_source_url` var and the same script downloads a real
   region from openaddresses.io instead. Script actions never receive warehouse credentials —
   they produce files.

   ```yaml
   actions:
     - python:
         name: fetch_openaddresses
         file: loader/fetch_openaddresses.py
         pythonVersion: ">=3.9"
         tags: ["ingest"]
   ```

2. **A `type: "import"` action** (`definitions/sources/openaddresses_us.sqlx`) — a
   **file → warehouse-table producer** powered by the runner-side DuckDB bridge — loads what
   the script staged, depending on it like any other action:

   ```js
   config {
     type: "import",
     dataset: "oa_ext",
     name: "openaddresses_us",
     dependencyTargets: [{name: "fetch_openaddresses"}],
     import: { location: "data/openaddresses_us.csv", format: "csv", overwrite: true }
   }
   ```

`sqlanvil validate` covers the script too: it checks the interpreter against `pythonVersion`,
any `requirements:` manifest against the installed packages, and the script's syntax — without
executing anything (the Python analog of `EXPLAIN`).

Downstream, the pattern mirrors a production warehouse ingestion:

- `oa_ext.stg_addresses` — normalizes OpenAddresses' standard columns
  (`lon`/`lat`/`number`/`street`/…) to documented names and drops rows without
  coordinates (the sample data includes one broken row to prove the filter).
- `public.addresses_cache` — the optimized geocoding table. Where a BigQuery
  pipeline would use *clustering* on `(state, postcode)`, Postgres uses
  **composite indexes** — declared right in the config's `postgres: { indexes: [...] }`.
- `assert_address_coordinates_valid` — coordinates in US bounds, 5-digit ZIPs;
  broken geocodes never silently reach the mailing list.
- `mailing_list_candidates` — LEFT JOINs customers to address points on
  `(zip, street address)`; `COALESCE` falls back to the ZIP centroid. One sample
  customer (Erin) deliberately doesn't geocode, so both paths show up in the output.

The bundled `data/openaddresses_sample.csv` is a 12-row slice in OpenAddresses'
standard 11-column layout so the example runs out of the box. For real data, set
the `oa_source_url` var to a region/state download from
[openaddresses.io](https://openaddresses.io) (free account) — same schema,
millions of rows; alternatively skip the script and point the import's
`location:` straight at an `s3://`/`gs://` URI (add the bucket credentials under
`storage` in `.df-credentials.json`).

> **SQLAnvil Cloud note:** hosted runs reject *local* file paths — and python
> script actions — at compile time (an ephemeral runner's disk isn't durable, and
> user code doesn't execute on the shared runner). Run this chain with the local
> CLI or your own CI; on Cloud, stage the file on `s3://`/`gs://` and drop the
> script action.

## Prerequisites

- A **Supabase project** with the `wrappers` and `postgis` extensions enabled
  (Dashboard → Database → Extensions).
- A **GCP service account** with a billing-enabled project and BigQuery read access.
  Querying public datasets is free up to the monthly tier, but BigQuery still needs
  a billing project to run the query. Set that project as `billingProject` on the
  connection (the source `bigquery-public-data` can be read but not billed) — the FDW
  then bills your project and reads the source via a full-FQN subquery. The service
  account needs `roles/bigquery.jobUser` on your billing project.
- `@sqlanvil/cli` (`npm i -g @sqlanvil/cli`).

> The BigQuery wrapper relies on Supabase's `wrappers` extension. It works on
> Supabase (or self-managed Postgres where you've installed `wrappers`), **not** on
> managed Postgres like RDS/Cloud SQL out of the box.

## Use this standalone

The example lives inside the sqlanvil repo, but a real project is its own directory
with a pinned core version. To pull it into a local area:

```bash
# 1. Copy just this directory out of a repo checkout into your own project dir
cp -R examples/supabase_bigquery_mailing_list ~/proximity-mailing-list
cd ~/proximity-mailing-list

# 2. Install the CLI and pin the core version
npm i -g @sqlanvil/cli
```

Then pin the core version by uncommenting `sqlanvilCoreVersion` in
`workflow_settings.yaml` (use **1.1.1 or newer** — 1.1.0 shipped named connections
but had a bug that dropped them in the published package):

```yaml
sqlanvilCoreVersion: 1.1.1
```

With a version pinned, the CLI fetches the matching `@sqlanvil/core` for you on first
compile — no `npm install` step in the project. (Inside this repo the line is left
commented so the example compiles against the local in-tree core instead.)

## One-time: store the service-account key in Vault

The connection references the SA key by a Vault secret **id** — the key JSON itself
never lives in this repo. Create the secret once in the Supabase SQL editor:

```sql
-- Paste your service-account JSON. Returns the secret id.
select vault.create_secret('<paste service-account JSON>', 'bigquery_sa');

-- Read the id back:
select id from vault.secrets where name = 'bigquery_sa';
```

Copy the returned id into `workflow_settings.yaml` →
`connections.bigquery_public.saKeyId` (replacing `REPLACE_WITH_VAULT_SECRET_ID`).

## Configure

```bash
cp .df-credentials.example.json .df-credentials.json
# Fill in the Supabase Session pooler connection (host verbatim from the
# dashboard Connect dialog; user = postgres.<project-ref>; sslMode require).
```

`.df-credentials.json` is gitignored and holds your write warehouse (Supabase)
secret. The BigQuery source connection carries no secret in config — only the Vault
`saKeyId` pointer set above.

## Run

```bash
# Static compile first to check the graph (no warehouse connection needed):
sqlanvil compile .

# Then build everything:
sqlanvil run .
```

(From inside the sqlanvil repo, point the commands at the path instead:
`sqlanvil run examples/supabase_bigquery_mailing_list`.)

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

## Regenerating the source declaration

`definitions/sources/zip_codes.sqlx` was generated by introspecting the BigQuery
table over the named connection. To regenerate it (e.g. after a schema change):

```bash
sqlanvil introspect bigquery_public geo_us_boundaries.zip_codes \
  --output definitions/sources/zip_codes.sqlx
```

## What's in here

| Path | Purpose |
|------|---------|
| `workflow_settings.yaml` | Warehouse (`supabase`) + the `bigquery_public` named connection + audience vars |
| `definitions/sources/zip_codes.sqlx` | `connection:`-tagged declaration → auto-generates the FDW bridge + `ref()`-able `zip_codes` foreign table |
| `definitions/staging/stg_zip_codes.sqlx` | Shaped view over the live foreign table |
| `definitions/staging/zip_codes_cache.sqlx` | Materializes BigQuery zip centroids into Supabase |
| `definitions/operational/*.sqlx` | Sample `customers` + `sales_orders` |
| `definitions/marts/mailing_list*.sqlx` | Join + PostGIS distance → final mailing list |
| `definitions/assertions/*.sqlx` | Data-quality checks (non-null email, non-negative distance) |
