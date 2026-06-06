# Connections + read-only FDW bridge (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named connections to `workflow_settings.yaml` and let a `declaration` reference a non-warehouse connection as a read-only source that SQLAnvil auto-bridges (FDW) into a `ref()`-able object, for a Postgres/Supabase warehouse reading BigQuery + Postgres sources.

**Architecture:** A `connections` map (proto + parsed into `ProjectConfig`) defines named sources; `warehouse:` may name one as the R/W target. `declaration` gains `connection` + `columnTypes`. When `session.declare()` sees a connection-tagged declaration, it generates (deduped per connection) a `Wrapper` server-setup action and a ref-able `ForeignTable` — reusing the machinery from the FDW feature — instead of a plain `Declaration`. Compile uses only non-secret connection-definition values; secrets (Vault secret / user mapping) are documented one-time setup, never generated. (Spec: `docs/superpowers/specs/2026-06-05-connections-design.md`.)

**Tech Stack:** TypeScript, Bazel (via `./scripts/docker-bazel`), protobuf (proto change → regen), Mocha/Chai.

**Build/test note (macOS):** native Bazel is broken — run via `./scripts/docker-bazel test <target> --jobs=2 --local_ram_resources=2048 --test_output=errors`. Proto-dependent targets rebuild automatically. Work on branch `feat/connections`.

---

## File Structure

- Modify `protos/configs.proto` — new `ConnectionConfig` message; `WorkflowSettings.connections` (18); `DeclarationConfig.connection` (8) + `column_types` (9).
- Modify `protos/core.proto` — `ProjectConfig.connections` (23).
- Modify `core/workflow_settings.ts` — parse `connections`; resolve `warehouse:` that names a connection.
- Modify `core/session.ts` — `declare()` bridge expansion (validation + Wrapper/ForeignTable generation, deduped per connection).
- Reuse `core/actions/wrapper.ts` (add a `postgres_fdw` provider preset) and `core/actions/foreign_table.ts` (unchanged).
- Tests: `core/main_test.ts` (config parsing), `core/actions/supabase_actions_test.ts` (bridge + errors).

---

## Task 1: Proto — connections + declaration fields

**Files:** Modify `protos/configs.proto`, `protos/core.proto`

- [ ] **Step 1: Add `ConnectionConfig` + `WorkflowSettings.connections` in `protos/configs.proto`**

Add a top-level message (after `message WorkflowSettings { … }`'s closing brace, before `message DefaultIcebergConfig`):

```proto
// A named connection: the warehouse (read/write target) or a read-only source.
message ConnectionConfig {
  // "bigquery" | "postgres" | "supabase".
  string platform = 1;
  // BigQuery source defaults.
  string project = 2;
  string dataset = 3;
  // Non-secret Vault secret id used in generated BigQuery FDW server DDL.
  string sa_key_id = 4;
  // Postgres source connection params (non-secret; password lives in .df-credentials.json).
  string host = 5;
  int32 port = 6;
  string database = 7;
  // Postgres/Supabase default schema.
  string default_schema = 8;
}
```

Inside `message WorkflowSettings`, after `string warehouse = 17;`, add:

```proto
  // Optional. Named connections (warehouse + read-only sources).
  map<string, ConnectionConfig> connections = 18;
```

- [ ] **Step 2: Add `connection` + `column_types` to `DeclarationConfig` in `protos/configs.proto`**

Inside `message DeclarationConfig`, after `repeated string tags = 7;`, add:

```proto
    // Optional. Name of a connection (from WorkflowSettings.connections) that this
    // declaration reads from. Only valid on declarations.
    string connection = 8;

    // Optional. Column name -> SQL type, used to generate the foreign table when
    // `connection` bridges via FDW. Distinct from `columns` (descriptions).
    map<string, string> column_types = 9;
```

- [ ] **Step 3: Add `ProjectConfig.connections` in `protos/core.proto`**

Inside `message ProjectConfig`, before the `reserved` line, add:

```proto
  map<string, ConnectionConfig> connections = 23;
```

(`core.proto` already `import "configs.proto"`, so `ConnectionConfig` resolves.)

- [ ] **Step 4: Rebuild protos + TS bindings**

Run: `./scripts/docker-bazel build //protos:ts --jobs=2 --local_ram_resources=2048`
Expected: builds successfully (the generated `sqlanvil` TS namespace now exposes `ConnectionConfig`, `WorkflowSettings.connections`, `ProjectConfig.connections`, `DeclarationConfig.connection`/`columnTypes`).

- [ ] **Step 5: Commit**

```bash
git add protos/configs.proto protos/core.proto
git commit -m "feat(proto): ConnectionConfig + connections maps + declaration connection/columnTypes"
```

---

## Task 2: Parse connections + warehouse-as-connection resolution

**Files:** Modify `core/workflow_settings.ts`; Test: `core/main_test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `core/main_test.ts` (follow the existing suite's project-dir + `runMainInVm` pattern used by other workflow-settings tests). Add a suite-local helper if needed; these assert on `result.compile.compiledGraph.projectConfig`:

```typescript
  test("connections are parsed into projectConfig and warehouse can name one", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultDataset: analytics
warehouse: my_supabase
connections:
  my_supabase:
    platform: supabase
    defaultSchema: public
  bigquery_public:
    platform: bigquery
    project: bigquery-public-data
    dataset: geo_us_boundaries
    saKeyId: vault-123`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const pc = asPlainObject(result.compile.compiledGraph.projectConfig);
    // warehouse names a connection -> resolves to that connection's platform
    expect(pc.warehouse).equals("supabase");
    expect(pc.connections.bigquery_public.platform).equals("bigquery");
    expect(pc.connections.bigquery_public.saKeyId).equals("vault-123");
    expect(pc.connections.my_supabase.platform).equals("supabase");
  });

  test("legacy flat warehouse string still works with no connections", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultDataset: analytics\nwarehouse: postgres`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const pc = asPlainObject(result.compile.compiledGraph.projectConfig);
    expect(pc.warehouse).equals("postgres");
  });
```

Ensure the file imports `coreExecutionRequestFromPath`, `runMainInVm`, `asPlainObject`, `fs`, `path` (mirror `core/actions/supabase_actions_test.ts` imports if `main_test.ts` lacks any).

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //core:main_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `connections` isn't copied to projectConfig, and `warehouse: my_supabase` currently throws "Unsupported warehouse".

- [ ] **Step 3: Implement in `core/workflow_settings.ts`**

In `workflowSettingsAsProjectConfig`, replace the warehouse block (currently lines ~157-168) with connection-aware resolution, and copy connections:

```typescript
  if (workflowSettings.connections) {
    projectConfig.connections = workflowSettings.connections;
  }

  const supportedWarehouses = ["bigquery", "postgres", "supabase"];
  if (workflowSettings.warehouse) {
    const named = workflowSettings.connections?.[workflowSettings.warehouse];
    // `warehouse:` may name a connection; otherwise it's a legacy platform string.
    const platform = named ? named.platform : workflowSettings.warehouse;
    if (!supportedWarehouses.includes(platform)) {
      throw new Error(
        `Unsupported warehouse "${workflowSettings.warehouse}". ` +
          `Supported warehouses: ${supportedWarehouses.join(", ")}.`
      );
    }
    projectConfig.warehouse = platform;
    if (named) {
      projectConfig.warehouseConnection = workflowSettings.warehouse;
    }
  } else {
    projectConfig.warehouse = "bigquery";
  }
```

Add `string warehouse_connection = 24;` to `ProjectConfig` in `protos/core.proto` (records which connection name is the warehouse, so `session.declare` can tell warehouse vs source), then rebuild protos (`./scripts/docker-bazel build //protos:ts …`).

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //core:main_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS (both new tests; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add protos/core.proto core/workflow_settings.ts core/main_test.ts
git commit -m "feat(config): parse connections; warehouse: may name a connection"
```

---

## Task 3: Declaration bridge — validation & errors

**Files:** Modify `core/session.ts`; Test: `core/actions/supabase_actions_test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `core/actions/supabase_actions_test.ts`:

```typescript
  test("connection-tagged declaration requires columnTypes", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: d\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "bq", schema: "geo_us_boundaries", name: "zip_codes" });`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errs = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errs.join("\n")).to.match(/requires `?columnTypes`?/);
  });

  test("declaration on an unknown connection errors", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: d\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "nope", schema: "s", name: "t", columnTypes: { a: "text" } });`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errs = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errs.join("\n")).to.match(/Unknown connection "nope"/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //core:actions/supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `declare` ignores `connection`, so no errors are raised.

- [ ] **Step 3: Implement validation in `core/session.ts` `declare()`**

Replace the current `declare()` body:

```typescript
  public declare(config: sqlanvil.ActionConfig.DeclarationConfig | any): Declaration {
    const filename = utils.getCallerFile(this.rootDir);
    const connectionName = config.connection;
    const warehouseConnection = this.projectConfig.warehouseConnection;

    // No connection, or it points at the warehouse itself => plain declaration.
    if (!connectionName || connectionName === warehouseConnection) {
      const declaration = new Declaration(this, config, filename);
      this.actions.push(declaration);
      return declaration;
    }

    const connections = this.projectConfig.connections || {};
    const connection = connections[connectionName];
    const declaration = new Declaration(this, config, filename); // for getTarget()/error reporting
    if (!connection) {
      this.compileError(
        new Error(`Unknown connection "${connectionName}" on declaration "${config.name}".`),
        filename,
        declaration.getTarget()
      );
      this.actions.push(declaration);
      return declaration;
    }
    const columnTypes = config.columnTypes || {};
    if (Object.keys(columnTypes).length === 0) {
      this.compileError(
        new Error(
          `Declaration "${config.name}" on connection "${connectionName}" requires ` +
            "`columnTypes`; run `sqlanvil introspect " +
            `${connectionName} ${config.schema || ""}.${config.name}\`.`
        ),
        filename,
        declaration.getTarget()
      );
      this.actions.push(declaration);
      return declaration;
    }

    // Bridge generation happens in Task 4/5; for now, surface unsupported pairs.
    this.compileError(
      new Error(
        `Reading connection "${connectionName}" (${connection.platform}) from a ` +
          `${this.projectConfig.warehouse} warehouse is not yet supported.`
      ),
      filename,
      declaration.getTarget()
    );
    this.actions.push(declaration);
    return declaration;
  }
```

(`compileError` already exists on `Session`; confirm its signature by grep and match it.)

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //core:actions/supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS for both new tests (the "unsupported pair" branch is replaced with real bridging in Task 4/5).

- [ ] **Step 5: Commit**

```bash
git add core/session.ts core/actions/supabase_actions_test.ts
git commit -m "feat(connections): validate connection-tagged declarations (unknown conn, columnTypes)"
```

---

## Task 4: BigQuery-source FDW bridge

**Files:** Modify `core/session.ts`, `core/actions/wrapper.ts`; Test: `core/actions/supabase_actions_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  test("declaration on a bigquery connection generates a ref-able FDW bridge", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "bq", name: "zip_codes", columnTypes: { zip_code: "text", lat: "float8" } });`
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/use.sqlx"),
      `config { type: "view", schema: "public" }\nSELECT zip_code FROM \${ref("zip_codes")}`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const ops = asPlainObject(result.compile.compiledGraph.operations);
    const ft = ops.find((op) => op.target.name === "zip_codes");
    expect(ft).to.exist;
    expect(ft.target.schema).equals("bq_ext");
    expect(ft.hasOutput).equals(true);
    expect(ft.queries[1]).equals(
      `create foreign table "bq_ext"."zip_codes" ("zip_code" text, "lat" float8) server "bq_srv" options (table 'zip_codes')`
    );
    const server = ops.find((op) => op.target.name === "bq_srv");
    expect(server.queries[0]).equals('create extension if not exists "wrappers" cascade');
    const view = asPlainObject(result.compile.compiledGraph.tables).find((t) => t.target.name === "use");
    expect(view.dependencyTargets.map((t) => t.name)).deep.equals(["zip_codes"]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //core:actions/supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — currently the bigquery pair hits the "not yet supported" error.

- [ ] **Step 3: Implement the bridge in `core/session.ts`**

Add a private field on `Session` to dedupe server setups: `private foreignServers = new Set<string>();` (near other private fields).

Replace the "unsupported pair" block at the end of `declare()` with:

```typescript
    if (this.projectConfig.warehouse !== "postgres" && this.projectConfig.warehouse !== "supabase") {
      this.compileError(
        new Error(
          `Reading connection "${connectionName}" from a ${this.projectConfig.warehouse} ` +
            "warehouse is not yet supported."
        ),
        filename,
        declaration.getTarget()
      );
      this.actions.push(declaration);
      return declaration;
    }

    const serverName = `${connectionName}_srv`;
    const extSchema = `${connectionName}_ext`;

    if (!this.foreignServers.has(connectionName)) {
      this.foreignServers.add(connectionName);
      if (connection.platform === "bigquery") {
        this.actions.push(
          new Wrapper(this, {
            filename,
            name: serverName,
            provider: "bigquery",
            server: serverName,
            serverOptions: { project_id: connection.project, dataset_id: connection.dataset },
            credential: { saKeyId: connection.saKeyId }
          })
        );
      } else {
        // postgres / supabase source via postgres_fdw
        this.actions.push(
          new Wrapper(this, {
            filename,
            name: serverName,
            provider: "postgres_fdw",
            server: serverName,
            serverOptions: {
              host: connection.host,
              port: String(connection.port || 5432),
              dbname: connection.database
            }
          })
        );
      }
    }

    const ftOptions =
      connection.platform === "bigquery"
        ? { table: config.name } // dataset is on the server (dataset_id from the connection)
        : { schema_name: config.schema || connection.defaultSchema || "public", table_name: config.name };

    this.actions.push(
      new ForeignTable(this, {
        filename,
        name: config.name,
        schema: extSchema,
        server: serverName,
        options: ftOptions,
        columns: config.columnTypes,
        dependsOn: serverName
      })
    );
    return declaration; // not pushed: the ForeignTable is the ref-able relation
```

Note the BigQuery foreign-table `location` option carries the source dataset (the
wrapper resolves the table within `dataset_id`; here we pass the declared schema or
the connection dataset). The `ForeignTable` `columns` field already renders
`name type` pairs (built for the FDW feature) — `config.columnTypes` is exactly that
shape.

Add a `postgres_fdw` preset to `WRAPPER_PROVIDERS` in `core/actions/wrapper.ts` (the
extension creates the FDW, so handler/validator are empty → the do-block is skipped):

```typescript
  postgres_fdw: {
    extension: "postgres_fdw",
    wrapper: "postgres_fdw",
    handler: "",
    validator: ""
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //core:actions/supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS (the bigquery-bridge test; earlier error tests still pass).

- [ ] **Step 5: Commit**

```bash
git add core/session.ts core/actions/wrapper.ts core/actions/supabase_actions_test.ts
git commit -m "feat(connections): generate ref-able BigQuery FDW bridge from a declaration"
```

---

## Task 5: Postgres-source FDW bridge + dedup

**Files:** Test: `core/actions/supabase_actions_test.ts` (implementation already added in Task 4; this verifies the Postgres path + server dedup)

- [ ] **Step 1: Write the failing/﻿passing test**

```typescript
  test("declaration on a postgres connection generates a postgres_fdw bridge, server deduped", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres\n    host: db.example.com\n    port: 5432\n    database: legacy\n    defaultSchema: public`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/src.js"),
      `declare({ connection: "legacy", name: "orders", columnTypes: { id: "bigint" } });\n` +
        `declare({ connection: "legacy", name: "customers", columnTypes: { id: "bigint" } });`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const ops = asPlainObject(result.compile.compiledGraph.operations);
    // exactly one server setup despite two declarations on the same connection
    expect(ops.filter((op) => op.target.name === "legacy_srv").length).equals(1);
    const server = ops.find((op) => op.target.name === "legacy_srv");
    expect(server.queries).deep.equals([
      'create extension if not exists "postgres_fdw" cascade',
      'drop server if exists "legacy_srv" cascade',
      `create server "legacy_srv" foreign data wrapper "postgres_fdw" options (host 'db.example.com', port '5432', dbname 'legacy')`
    ]);
    const orders = ops.find((op) => op.target.name === "orders");
    expect(orders.queries[1]).equals(
      `create foreign table "legacy_ext"."orders" ("id" bigint) server "legacy_srv" options (schema_name 'public', table_name 'orders')`
    );
  });
```

- [ ] **Step 2: Run to verify**

Run: `./scripts/docker-bazel test //core:actions/supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS (postgres bridge + single deduped server). If the server appears twice, the `foreignServers` dedup Set in Task 4 isn't working — fix there.

- [ ] **Step 3: Run the full core suite for regressions**

Run: `./scripts/docker-bazel test //core:main_test //core:actions/supabase_actions_test //core:actions/declaration_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add core/actions/supabase_actions_test.ts
git commit -m "test(connections): postgres_fdw bridge + per-connection server dedup"
```

---

## Self-Review

**Spec coverage:**
- `connections:` block + parse into projectConfig → Task 1, 2.
- `warehouse:` may name a connection; legacy string back-compat → Task 2.
- `connection` + `columnTypes` on declarations (proto) → Task 1.
- `connection` only valid on declarations → enforced by proto (other configs have no field); noted in Task 1.
- Conditional `columnTypes` requirement; unknown-connection error → Task 3.
- BigQuery-source FDW bridge (server + foreign table, ref-able, deps, non-secret saKeyId from def) → Task 4.
- Postgres-source FDW bridge (`postgres_fdw`, server + foreign table; user mapping NOT generated) + per-connection dedup → Task 5.
- Unsupported pair (non-PG/Supabase warehouse) error → Task 4.
- Introspect, `EXTERNAL_QUERY`, extract-load → **out of scope** (Plan B / future, per spec).

**Type consistency:** `foreignServers: Set<string>`, `Wrapper`/`ForeignTable` configs match their existing interfaces (`IWrapperConfig`, `IForeignTableConfig`); `provider: "postgres_fdw"` added to `WRAPPER_PROVIDERS`; `config.columnTypes` matches `ForeignTable`'s `columns` `{name: type}` shape; `projectConfig.warehouseConnection` added in Task 2 and read in Tasks 3-4.

**Placeholder scan:** every step has concrete code/commands. Two grounding confirmations the implementer must do inline (not placeholders — exact-match checks): the `Session.compileError(error, filename, target)` signature (grep `compileError` in `core/session.ts`) and that `main_test.ts` has the tmp-dir fixture + imports (mirror `supabase_actions_test.ts` if not).

**Open follow-ups (Plan B):** `sqlanvil introspect` (type-mapping + codegen of `columnTypes`), and documenting the one-time `vault.create_secret` / `CREATE USER MAPPING` setup in an example.
