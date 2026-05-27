# Hybrid Warehouse Architecture: Supabase & BigQuery

This document outlines how **SqlAnvil** (Dataform) supports both **PostgreSQL (Supabase)** and **Google BigQuery**, and details the architectural patterns for utilizing both warehouses together as sources, targets, or coexisting elements in your data stack.

---

## 1. Multi-Warehouse Coexistence in SqlAnvil

SqlAnvil is architected around a unified interface, the **`IDbAdapter`** (defined in [cli/api/dbadapters/index.ts](file:///Users/ivan/projects-ivan/sqlanvil/cli/api/dbadapters/index.ts)). This design allows multiple database clients to coexist in the codebase without conflict.

```
       [ SqlAnvil CLI / Core Engine ]
                     │
            ┌────────┴────────┐
      ( warehouse:      ( warehouse: 
      "bigquery" )      "postgres" )
            │                 │
            ▼                 ▼
     [ BigQueryAdapter ] [ PostgresAdapter ]
            │                 │
            ▼                 ▼
     [ Google Cloud ]    [ Supabase / PG ]
```

* **Dynamic Instantiation:** The CLI reads your project's `dataform.json` config. Depending on the `"warehouse"` configuration, it dynamically instantiates either the `BigQueryDbAdapter` or `PostgresDbAdapter` to execute the compiled SQL graph.
* **No Code Bloat:** Adapters are isolated from each other. You can safely build and scale both database engines inside the same command-line tool.

---

## 2. Hybrid Pipeline Design Patterns

While an individual SqlAnvil execution targets a single connection, you can seamlessly combine Supabase and BigQuery to build powerful hybrid analytics stacks.

### Pattern A: BigQuery Federated Queries (Supabase &rarr; BigQuery)
This is the most direct way to model Supabase data inside a BigQuery analytical warehouse without building separate ETL pipelines.

1. **Setup:** Create a secure **Cloud SQL External Connection** in your Google Cloud Platform console pointing directly to your Supabase PostgreSQL database.
2. **Execution:** Configure your SqlAnvil project to target **BigQuery**.
3. **Modeling:** In your `.sqlx` files, query live Supabase tables in real-time using BigQuery's native `EXTERNAL_QUERY` dialect:
   ```sql
   config {
     type: "table",
     name: "modeled_users"
   }

   SELECT 
     user_id,
     email,
     TIMESTAMP(created_at) as created_at,
     CURRENT_TIMESTAMP() as synchronized_at
   FROM EXTERNAL_QUERY(
     "your-gcp-project.us.supabase-connection-id", 
     "SELECT id as user_id, email, created_at FROM auth.users;"
   )
   ```
* **Pros:** Real-time data access, zero-ETL setup, runs fully inside BigQuery's highly scalable compute layer.

---

### Pattern B: Sequential Multi-Warehouse Modeling
For larger apps, it is often optimal to run lightweight schema cleanups locally on the transactional database before running heavy analytical pipelines in the cloud.

1. **Transactional Stage (Supabase):**
   * Configure a SqlAnvil project targeting **PostgreSQL**.
   * Run pipelines directly on your Supabase DB to clean operational tables, pre-aggregate metrics (e.g. daily transaction summaries), and keep transactional views fast.
2. **Replication Stage:**
   * Replicate the structured transactional summaries from Supabase to Google BigQuery (using tools like Airbyte, Fivetran, or simple scheduled script transfers).
3. **Analytical Stage (BigQuery):**
   * Run a separate SqlAnvil pipeline targeting **BigQuery** to perform deep BI analysis, machine learning model integrations, or historical trend analysis on top of the replicated summaries.

---

### Pattern C: Supabase Wrappers (BigQuery &rarr; Supabase)
If your application needs to display high-level analytical results (computed in BigQuery) to end-users inside the live Supabase app, you can use **Supabase Wrappers** (Postgres Foreign Data Wrappers).

1. **Model in BigQuery:** Use SqlAnvil to process high-compute metrics in BigQuery (e.g., predicting customer churn risk or computing multi-month cohort retention).
2. **Expose in Supabase:**
   * Enable the BigQuery Wrapper in your Supabase database.
   * Query the resulting BigQuery analytical table as a Foreign Table directly inside your Supabase Postgres schema.
   * Your frontend web/mobile application can query the metrics instantly using standard Supabase client SDKs (`supabase.from('churn_predictions')`).

---

## 3. Comparative Matrix: Supabase (PostgreSQL) vs. BigQuery

| Dimension | PostgreSQL (Supabase) | Google BigQuery |
| :--- | :--- | :--- |
| **Primary Use Case** | Real-time transactional app database (OLTP) | Large-scale analytics and data warehousing (OLAP) |
| **SqlAnvil Adapter** | `PostgresDbAdapter` (uses node-postgres) | `BigQueryDbAdapter` (uses `@google-cloud/bigquery`) |
| **Storage & Cost** | Provisioned disk space; fixed monthly costs | Pay-per-query scan & serverless storage |
| **Dialect** | Standard ANSI PostgreSQL | Google Standard SQL |
| **Execution Scale** | Excellent for thousands of quick reads/writes | Excellent for millions/billions of row transformations |
