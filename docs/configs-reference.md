# Configs Reference

SQLAnvil actions are configured at two levels:

1. **Project-level** — `workflow_settings.yaml` at the root of your project, defining the warehouse connection and global defaults.
2. **Action-level** — the `config {}` block in SQLX files, or the action entry in `actions.yaml`, defining per-action behavior (type, dependencies, schema, warehouse-specific options).

For the complete proto-generated field reference (all action config fields), see [Configs Proto Reference](/reference/configs).

---

## `workflow_settings.yaml` — warehouse config

The `warehouse:` block is a discriminated union on `kind`. Connection fields and defaults are namespaced under the block.

### BigQuery

```yaml
warehouse:
  kind: bigquery
  project: my-gcp-project       # GCP project ID (required)
  location: US                   # BigQuery location (required)
  defaultDataset: analytics      # default dataset for all actions
  defaultReservation: ""         # optional — BigQuery reservation URI

vars:
  env: production
```

### PostgreSQL

```yaml
warehouse:
  kind: postgres
  host: db.example.com
  port: 5432
  database: analytics
  user: sqlanvil_writer
  password: ${PG_PASSWORD}       # environment variable interpolation
  ssl: require                   # disable | allow | prefer | require | verify-full
  defaultSchema: public

vars:
  env: production
```

### Supabase

```yaml
warehouse:
  kind: supabase
  projectRef: abcdefghijklmnop   # from your Supabase dashboard
  serviceRoleKey: ${SUPABASE_SERVICE_ROLE_KEY}
  defaultSchema: public
  # Alternative: direct DB URL (bypasses PostgREST)
  # connectionString: postgresql://postgres:${PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres
```

---

## Action config blocks

### Common fields (all warehouses)

```sql
config {
  type: "table",                  -- table | view | incremental | assertion | operation | declaration
  schema: "my_schema",           -- overrides defaultDataset / defaultSchema
  database: "my_db",             -- overrides default project / database
  description: "My table.",
  tags: ["daily", "core"],
  disabled: false,
  hermetic: true,
  dependOnDependencyAssertions: true,
  dependencies: ["other_table"]
}
```

### BigQuery-specific fields

```sql
config {
  type: "table",
  partitionBy: "DATE(created_at)",          -- BigQuery only
  partitionExpirationDays: 90,              -- BigQuery only
  clusterBy: ["customer_id", "region"],     -- BigQuery only
  labels: { team: "analytics" },            -- BigQuery only
  additionalOptions: { kms_key_name: "..." }, -- BigQuery only
  reservation: "projects/.../reservations/my-res" -- BigQuery only
}
```

### PostgreSQL-specific fields

```sql
config {
  type: "table",
  postgres: {
    tablespace: "fast_ssd",
    fillfactor: 80,
    unlogged: false,
    partition: {
      kind: "range",         -- range | list | hash
      columns: ["order_date"]
    },
    indexes: [
      {
        name: "ix_orders_customer",
        columns: ["customer_id"],
        method: "btree",     -- btree | hash | gin | gist | brin
        unique: false,
        where: "",           -- partial index predicate
        include: []          -- covering index columns
      }
    ]
  }
}
```

### Supabase-specific fields

> **Coming soon** — available when the Supabase adapter ships.

```sql
config {
  type: "table",
  supabase: {
    enableRls: true,
    publishToRealtime: true,
    ownerRole: "postgres",
    vectors: [
      {
        column: "embedding",
        dimensions: 1536,
        indexType: "hnsw",
        params: { m: "16", ef_construction: "64" }
      }
    ]
  }
}
```

---

## Cross-warehouse compatibility

| Feature | BigQuery | Postgres | Supabase |
|---------|----------|----------|---------|
| `partitionBy` / `clusterBy` | ✓ | ✗ (use `postgres.partition`) | ✗ |
| `postgres.indexes` | ✗ | ✓ | ✓ |
| `labels` | ✓ | ✗ | ✗ |
| `reservation` | ✓ | ✗ | ✗ |
| `materialized` view | ✓ (auto-refresh) | ✓ (manual refresh) | ✓ (manual refresh) |
| `supabase.enableRls` | ✗ | ✗ | ✓ |

SQLAnvil emits a **compilation error** if a warehouse-specific config field is used against the wrong `warehouse.kind`.
