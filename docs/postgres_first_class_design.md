# Postgres-First-Class Adapter Design

**Status:** Draft
**Replaces (in scope):** `docs/postgres_reintegration_assessment.md` Phase 3 framing
**Complements:** `docs/hybrid_warehouses_supabase_bigquery.md` (architectural patterns) — this doc is the implementation spec

## 0. TL;DR

The restored Postgres adapter must not be a BigQuery adapter with translated SQL. sqlanvil ships two warehouse variants — `postgres` (standard) and `supabase` (Postgres + Supabase platform features) — both generating idiomatic SQL with native action config blocks. A user who has never touched BigQuery must never see BigQuery quirks (`NOT ENFORCED` PKs, `OPTIONS(...)` table options, `PARTITION BY DATE_TRUNC(...)` clauses, `MERGE` dialect).

## 1. Why Not a BigQuery-Shaped Swap

The Antigravity assessment frames reintegration as: implement `IDbAdapter` for Postgres, branch on `projectConfig.warehouse`, done. That is necessary but not sufficient. It leaves three structural problems:

1. **SQL generation is BQ-shaped.** `core/compilation_sql/` was written around BigQuery's dialect (`MERGE`, `CREATE OR REPLACE TABLE ... OPTIONS(...)`, partitioning DSL). A `case warehouse` branch inside each generator produces brittle, half-translated SQL.
2. **Action config blocks are BQ-shaped.** `table.bigquery = { partitionBy, clusterBy, requirePartitionFilter, ... }` exposes BigQuery concepts. Postgres equivalents (`tablespace`, `fillfactor`, native `PARTITION BY RANGE/LIST/HASH`, btree/gin/gist/hnsw indexes) don't map. Forcing them through BQ-shaped fields is leaky.
3. **Supabase isn't just "Postgres on a host."** RLS, Realtime publications, `auth.users` integration, pgvector, pg_cron, Supabase Wrappers — none of these are addressable via a generic Postgres adapter, and all of them are why someone picks Supabase.

## 2. Adapter Architecture

```
PostgresDbAdapter           (postgres)
    │
    ├── implements IDbAdapter
    ├── uses node-postgres (`pg`, `pg-query-stream`)
    ├── delegates SQL generation to PostgresSqlGenerator
    └── connection: standard libpq DSN / JDBC-style credential

SupabaseDbAdapter extends PostgresDbAdapter   (supabase)
    │
    ├── inherits all Postgres behavior
    ├── adds: RLS introspection, Realtime publication management,
    │         Supabase Wrapper foreign-server discovery
    ├── delegates SQL generation to SupabaseSqlGenerator
    │   (extends PostgresSqlGenerator)
    └── connection: Supabase project credentials
        (project_ref + service_role_key OR direct DB url + service_role for RLS bypass)
```

Both adapters live under `cli/api/dbadapters/`. SQL generators live under `core/compilation_sql/postgres/` and `core/compilation_sql/supabase/`.

### 2.1 `IDbAdapter` Surface

Methods the BigQuery adapter exposes today (`executeRaw`, `tables`, `deleteTable`, `prepareSchema`, `dryRun`, ...) must all be implementable against `pg` without semantic distortion. Where BigQuery returns BQ-specific metadata (`tableType: "VIEW" | "TABLE" | "MATERIALIZED_VIEW" | "EXTERNAL"`), Postgres returns its equivalent set (`tableType: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "FOREIGN_TABLE" | "PARTITIONED_TABLE"`). The `ITableMetadata` interface should be a union over warehouse-specific extensions, not a lowest-common-denominator struct.

## 3. Action Config Schema

### 3.1 Proto changes (`protos/configs.proto`)

Add two new message types alongside the existing `BigQueryOptions`:

```proto
message PostgresOptions {
  // Physical storage
  string tablespace = 1;
  uint32 fillfactor = 2;
  bool unlogged = 3;

  // Partitioning (native Postgres declarative partitioning)
  message Partition {
    enum Kind { RANGE = 0; LIST = 1; HASH = 2; }
    Kind kind = 1;
    repeated string columns = 2;
  }
  Partition partition = 4;

  // Indexes
  message Index {
    string name = 1;
    repeated string columns = 2;
    enum Method { BTREE = 0; HASH = 1; GIN = 2; GIST = 3; BRIN = 4; }
    Method method = 3;
    string where = 4;       // partial index predicate
    bool unique = 5;
    repeated string include = 6;  // INCLUDE columns
  }
  repeated Index indexes = 5;

  // Materialized view options
  bool with_data = 6;       // WITH DATA / WITH NO DATA on initial creation
  string refresh_policy = 7; // "manual" | "on_dependency_change"
}

message SupabaseOptions {
  // Standard Postgres options apply
  PostgresOptions postgres = 1;

  // Supabase platform
  bool publish_to_realtime = 2;        // ALTER PUBLICATION supabase_realtime
  bool enable_rls = 3;                  // ALTER TABLE ... ENABLE ROW LEVEL SECURITY
  string owner_role = 4;                // typically "postgres" or "service_role"

  // pgvector convenience (otherwise expressible via PostgresOptions.indexes)
  message VectorConfig {
    string column = 1;
    uint32 dimensions = 2;
    enum IndexType { IVFFLAT = 0; HNSW = 1; }
    IndexType index_type = 3;
    map<string, string> params = 4;   // ivfflat: lists; hnsw: m, ef_construction
  }
  repeated VectorConfig vectors = 5;
}
```

### 3.2 TypeScript action surface

```typescript
publish("daily_orders", {
  type: "incremental",
  uniqueKey: ["order_id"],
  postgres: {
    partition: { kind: "range", columns: ["order_date"] },
    indexes: [
      { name: "ix_daily_orders_customer", columns: ["customer_id"], method: "btree" },
      { name: "ix_daily_orders_search", columns: ["description"], method: "gin" }
    ]
  }
}).query(ctx => `SELECT ... FROM ${ctx.ref("raw_orders")} WHERE order_date >= ${ctx.incremental() ? "(SELECT MAX(order_date) FROM ${ctx.self()})" : "'2020-01-01'"}`);
```

Compare to existing BigQuery shape:

```typescript
publish("daily_orders", {
  type: "incremental",
  bigquery: { partitionBy: "DATE(order_date)", clusterBy: ["customer_id"], requirePartitionFilter: true }
}).query(...);
```

Each warehouse owns its own config namespace. Compilation errors if the wrong block is used against the wrong warehouse.

## 4. SQL Generation Differences

| Concern | BigQuery (existing) | Postgres (this spec) |
| :--- | :--- | :--- |
| Create table | `CREATE OR REPLACE TABLE \`x.y.z\` OPTIONS(...) AS SELECT ...` | `CREATE TABLE schema.tbl (...); INSERT INTO ...` (atomic via `BEGIN; DROP IF EXISTS; CREATE; INSERT; COMMIT;`) |
| Replace table | Single-statement `CREATE OR REPLACE TABLE` | Transactional drop + create + populate |
| Incremental upsert | `MERGE ... USING ... WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT` | `INSERT ... ON CONFLICT (cols) DO UPDATE SET ...` |
| View | `CREATE OR REPLACE VIEW` | `CREATE OR REPLACE VIEW` (works in PG) |
| Materialized view | `CREATE MATERIALIZED VIEW` (auto-refresh) | `CREATE MATERIALIZED VIEW ... WITH [NO] DATA;` + explicit `REFRESH MATERIALIZED VIEW [CONCURRENTLY]` |
| Partitioning | `PARTITION BY DATE(col)`, `PARTITION BY RANGE_BUCKET(col, ...)` | `PARTITION BY RANGE/LIST/HASH (cols)` + `CREATE TABLE part PARTITION OF parent FOR VALUES ...` |
| Clustering | `CLUSTER BY col1, col2` (storage layout) | No direct equivalent. Closest: `CLUSTER table USING index` (one-shot reorder) + appropriate btree index. Not silently translated. |
| Primary key | `CREATE PRIMARY KEY ... NOT ENFORCED` (informational only in BQ) | `PRIMARY KEY (...)` — actually enforced |
| Assertions | `SELECT ... FROM x WHERE failing_condition` | Same shape; can additionally compile to `CHECK` constraints when user opts in |

**Rule of thumb:** if BigQuery has a concept Postgres lacks (clustering, NOT ENFORCED PKs, `OPTIONS(description = ...)`), the Postgres generator either translates to the nearest meaningful equivalent **and warns in compilation output**, or refuses with a clear error pointing at `postgres:`-namespaced alternatives.

## 5. New Supabase-Native Action Types

Add to `core/actions/`:

### 5.1 `rlsPolicy`

```typescript
publish("orders_policy", {
  type: "rlsPolicy",
  table: "orders",
  name: "users_see_own_orders",
  command: "select",           // "all" | "select" | "insert" | "update" | "delete"
  roles: ["authenticated"],
  using: "user_id = auth.uid()",
  withCheck: "user_id = auth.uid()"
});
```

Compiles to:

```sql
CREATE POLICY users_see_own_orders ON orders
  FOR SELECT TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

Refs into tables work via the standard action graph — declaring an RLS policy creates a dependency edge to the underlying table.

### 5.2 `realtimePublication`

```typescript
publish("orders_realtime", {
  type: "realtimePublication",
  table: "orders",
  events: ["insert", "update", "delete"]
});
```

Compiles to `ALTER PUBLICATION supabase_realtime ADD TABLE orders;` (with replica identity adjustments).

### 5.3 `wrapper` (foreign-server / FDW)

Pairs with the hybrid-warehouse doc's Pattern C (BigQuery → Supabase):

```typescript
publish("bq_churn_predictions", {
  type: "wrapper",
  wrapper: "bigquery",
  server: "bq_analytics",
  options: { project: "my-bq-project", dataset: "models", table: "churn_predictions" }
});
```

Compiles to `CREATE FOREIGN TABLE ... SERVER bq_analytics OPTIONS (...)`.

### 5.4 `vectorIndex`

Convenience wrapper for pgvector — could also be expressed as a `PostgresOptions.Index` with `method: HNSW`, but a dedicated type makes RAG pipelines first-class.

## 6. Implementation Phases (Replaces Antigravity Phases 3-5)

Phases 1-2 (deps + relocation) from the Antigravity doc stand as written. The remaining work is re-scoped:

### Phase 3a — Adapter skeleton (1 day)
- Implement `PostgresDbAdapter` against `pg` and `pg-query-stream`.
- Map `IDbAdapter` methods to Postgres semantics. Where BigQuery returns warehouse-specific metadata, return Postgres equivalents — do not force into BQ shape.
- Credential format: standard `{ host, port, database, user, password, ssl }` (or DSN string). Separate from BigQuery's `{ projectId, credentials, location }`.

### Phase 3b — Postgres SQL generator (2-3 days)
- New directory: `core/compilation_sql/postgres/`.
- One generator per action type (table, view, incremental, materialized view, operation, assertion, declaration).
- Tests: `core/compilation_sql/postgres/*_test.ts`. Snapshot output against expected idiomatic Postgres SQL.

### Phase 3c — Action config schema additions (1 day)
- Add `PostgresOptions` and `SupabaseOptions` to `protos/configs.proto`.
- Surface in TypeScript action types alongside existing `bigquery:` namespace.
- Compilation errors for cross-warehouse misuse (`postgres:` block against `warehouse: "bigquery"`, etc.).

### Phase 4 — CLI wiring (0.5 day)
- Branch `cli/index.ts` adapter instantiation on `projectConfig.warehouse ∈ {bigquery, postgres, supabase}`.
- Credential file format auto-detection.
- `dataform init` (rename target: `sqlanvil init`) templates for both new warehouses.

### Phase 5 — Supabase variant (2-3 days)
- `SupabaseDbAdapter extends PostgresDbAdapter`.
- Supabase-specific SQL generator extensions.
- New action types: `rlsPolicy`, `realtimePublication`, `wrapper`, `vectorIndex`.
- Connection config supports both direct Postgres URL and Supabase project_ref + service_role_key.

### Phase 6 — Integration tests (1-2 days)
- Extend `tools/postgres/postgres_fixture.ts` with a parallel `tools/supabase/` fixture (Docker-compose'd Supabase stack — `supabase/postgres` image + Realtime + PostgREST optional).
- Test specs: `tests/integration/postgres.spec.ts` (already restored), new `tests/integration/supabase.spec.ts`.

**Revised total estimate: 7-10 engineering days.** Antigravity's 1-2 day estimate covers Phase 1-2 + a minimal Phase 3a only.

## 7. Risks Specific to This Approach

| Risk | Mitigation |
| :--- | :--- |
| Postgres + Supabase generator divergence over time | Supabase generator inherits from Postgres via class extension; share a fixture suite where behaviors overlap. |
| New action types (`rlsPolicy`, etc.) bloat the core graph | Gate them behind the Supabase variant; standard Postgres users never see them. |
| Connection-string format proliferation | Document one canonical format per variant; provide a `sqlanvil credentials check` subcommand that validates and reports which warehouse it inferred. |
| BigQuery users expecting feature parity (clustering, GA partition pruning) on Postgres | Compilation warnings + docs page mapping BQ concepts → Postgres equivalents, with explicit "no equivalent" markers. |

## 8. Resolved Decisions

### 8.1 Rename is mandatory and precedes public release

The full `dataform` → `sqlanvil` rename happens before any public-facing artifact ships. Trademark risk from Google is the driver. Scope:

- Proto package names: `dataform.proto.*` → `sqlanvil.proto.*`. Touches every `.proto` file's `package` line and every TS import of generated types.
- npm packages: `@dataform/core`, `@dataform/cli`, etc. → `@sqlanvil/core`, `@sqlanvil/cli`. Republish under new scope; old `@dataform/*` namespace was never Ivan's anyway.
- CLI binary: `dataform` → `sqlanvil`. Update `cli/BUILD`, `scripts/run`, install docs.
- Config files: `dataform.json` → `sqlanvil.json`. `workflow_settings.yaml` keys retained (already neutral).
- Internal class names: `IDataformConfig` → `ISqlanvilConfig`, etc.
- Docs, error messages, telemetry user-agent strings.

Recommended sequencing: **rename first, in a single sweep PR on the `restore-postgres-adapter` branch**, then layer the adapter work on top. Rationale: a partial rename is worse than either state — grep ambiguity, broken imports, mixed branding. Get it done in one painful day.

`sqlanvil-com/index.html` should also gain a one-line legal notice acknowledging the fork's origin per Apache 2.0 license terms (Dataform OSS is Apache-2.0; attribution is required, derivative naming is not — but credit upstream cleanly).

### 8.2 Connection config is nested under `warehouse:` block

Decision: **nested**. Shape:

```yaml
# workflow_settings.yaml — BigQuery variant
warehouse:
  kind: bigquery
  project: my-bq-project
  location: US
  defaultDataset: analytics

# workflow_settings.yaml — Postgres variant
warehouse:
  kind: postgres
  host: db.example.com
  port: 5432
  database: analytics
  user: sqlanvil_writer
  password: ${PG_PASSWORD}      # env interpolation
  ssl: require
  defaultSchema: public

# workflow_settings.yaml — Supabase variant
warehouse:
  kind: supabase
  projectRef: abcdefghijklmnop   # from supabase dashboard
  serviceRoleKey: ${SUPABASE_SERVICE_ROLE_KEY}
  defaultSchema: public
  # alternative: direct DB URL bypassing PostgREST
  # connectionString: postgresql://postgres:${PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres
```

Why nested over flat:

- **Extensibility.** Adding AlloyDB / CockroachDB / Redshift later = add a new `kind` value, not invent new top-level keys.
- **No naming collisions.** Flat `warehouse: postgres` collides semantically with `defaultDatabase: postgres` (kind vs database name). Nested removes the ambiguity.
- **Grouping.** All connection-affecting fields live in one block. Credentials, defaults, dialect flags all co-located.
- **Validation.** Discriminated union on `kind` — strict per-variant field validation, no global field that's only meaningful for some warehouses.

Proto representation (`protos/configs.proto`):

```proto
message WarehouseConfig {
  oneof connection {
    BigQueryConnection bigquery = 1;
    PostgresConnection postgres = 2;
    SupabaseConnection supabase = 3;
  }
}

message BigQueryConnection { string project = 1; string location = 2; string default_dataset = 3; }
message PostgresConnection { string host = 1; uint32 port = 2; string database = 3; string user = 4; string password = 5; string ssl_mode = 6; string default_schema = 7; }
message SupabaseConnection { string project_ref = 1; string service_role_key = 2; string default_schema = 3; string connection_string = 4; /* optional override */ }
```

YAML parser uses the `kind:` tag to discriminate before unmarshalling into the appropriate `oneof` arm.

### 8.3 No migration path needed from existing Dataform projects

Acuantia (`~/projects/acuantia-gcp-dataform/`) and other BQ-only Dataform projects stay on Google Cloud / upstream Dataform. They are **not** migration targets. sqlanvil's audience is new personal/OSS projects, especially Supabase-backed ones like **listanvil** (in this monorepo at `../listanvil/`).

This means: no need for `dataform-compat` translation layer, no need to accept `dataform.json` in addition to `sqlanvil.json`, no need to support `@dataform/...` action config blocks under the rename. Clean break.

## 9. Recommended Branch Strategy

Three sequential PRs on top of `restore-postgres-adapter`:

1. **`rename/dataform-to-sqlanvil`** — pure rename, no behavior change. Mechanical. Reviewable as a diff against upstream.
2. **`adapter/postgres-first-class`** — Phases 1-4 of section 6. New proto messages, Postgres SQL generator, `PostgresDbAdapter`, CLI wiring. No Supabase code yet.
3. **`adapter/supabase-variant`** — Phase 5-6. `SupabaseDbAdapter`, new action types (`rlsPolicy`, `realtimePublication`, `wrapper`, `vectorIndex`), Supabase integration fixture.

Each PR self-contained, mergeable independently. PR 1 unblocks any future public artifact; PRs 2-3 unblock listanvil-style projects using sqlanvil.
