# Cross-warehouse Mailing List (foreign_wrapper extension + example) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend SQLAnvil's JS-API `wrapper()` action so a single call declares a complete, correct BigQuery Foreign Data Wrapper bridge (extension → FDW → server → ref-able foreign tables), then ship a self-contained Supabase+BigQuery mailing-list example under `examples/`.

**Architecture:** The `wrapper()` action stays a JS-API function that compiles into the `operations` graph chunk. We enhance its `IWrapperConfig` with a `provider` preset, `serverOptions`, a `credential` reference, and a `foreignTables[]` list. `session.wrapper()` expands one call into a *server-setup* `Wrapper` operation plus one ref-able `ForeignTable` operation (`hasOutput: true`, depending on the setup) per foreign table. Credentials are referenced (Vault `sa_key_id` on Supabase) — the SA key JSON itself never enters SQLAnvil. The example consumes the foreign table via normal `ref()`.

**Tech Stack:** TypeScript, Bazel (via `./scripts/docker-bazel`), protobuf (no proto change needed), Mocha/Chai tests, Supabase (PostGIS + `wrappers` extension), BigQuery public data.

**Build/test note (macOS):** native Bazel is broken on this host — all builds/tests run via `./scripts/docker-bazel … --jobs=2 --local_ram_resources=2048`. The core unit test target is `//core/actions:supabase_actions_test`. Commits happen on branch `feat/foreign-wrapper-bigquery-mailing-list`.

---

## File Structure

**Core change (Phase 1):**
- Modify: `core/actions/wrapper.ts` — extend `IWrapperConfig`, add provider presets + credential handling, rewrite `compile()`.
- Create: `core/actions/foreign_table.ts` — new `ForeignTable` action (ref-able `create foreign table`).
- Modify: `core/actions/index.ts` — export `ForeignTable` / `IForeignTableConfig`, add to the `Action` union.
- Modify: `core/session.ts` — `wrapper()` expands into setup + per-table `ForeignTable` actions; add `ForeignTable` to the `operations` `instanceof` filter and imports.
- Modify: `core/actions/supabase_actions_test.ts` — extend with new behaviour tests.

**Example (Phase 2):** under `examples/supabase_bigquery_mailing_list/` — `workflow_settings.yaml`, `.df-credentials.example.json`, `definitions/**`, `README.md`.

---

## Phase 1 — Core: extend the `wrapper()` action

### Task 1: Provider preset + corrected server-setup DDL

**Files:**
- Modify: `core/actions/wrapper.ts`
- Test: `core/actions/supabase_actions_test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the `suite("supabase actions", …)` block:

```typescript
  test("wrapper with bigquery provider emits correct FDW + server DDL", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: supabase`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `
      wrapper({
        name: "bq_setup",
        provider: "bigquery",
        server: "bq_server",
        serverOptions: { project_id: "bigquery-public-data", dataset_id: "geo_us_boundaries" },
        credential: { saKeyId: "00000000-0000-0000-0000-000000000000" }
      });
      `
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(result.compile.compiledGraph.operations);
    const setup = operations.find((op) => op.target.name === "bq_setup");
    expect(setup).to.exist;
    expect(setup.queries).deep.equals([
      'create extension if not exists "wrappers" cascade',
      `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'bigquery_wrapper') then create foreign data wrapper bigquery_wrapper handler big_query_fdw_handler validator big_query_fdw_validator; end if; end $$`,
      'drop server if exists "bq_server" cascade',
      `create server "bq_server" foreign data wrapper "bigquery_wrapper" options (project_id 'bigquery-public-data', dataset_id 'geo_us_boundaries', sa_key_id '00000000-0000-0000-0000-000000000000')`
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — current `compile()` emits `create extension if not exists "bigquery"…`; `provider`/`serverOptions`/`credential` are not on `IWrapperConfig`.

- [ ] **Step 3: Write minimal implementation**

Replace `core/actions/wrapper.ts` with:

```typescript
import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IForeignTableConfigEntry {
  name: string;
  schema?: string;
  options?: { [key: string]: string };
  columns?: { [key: string]: string };
}

export interface IWrapperCredential {
  // Supabase: id of a pre-existing Vault secret holding the SA key JSON (a
  // non-secret pointer). The key JSON itself is never handled by SQLAnvil.
  saKeyId?: string;
  user?: string;
  password?: string;
}

export interface IWrapperConfig {
  name: string;
  provider?: string;
  wrapper?: string;
  handler?: string;
  validator?: string;
  server: string;
  serverOptions?: { [key: string]: string };
  options?: { [key: string]: string };
  credential?: IWrapperCredential;
  foreignTables?: IForeignTableConfigEntry[];
  filename?: string;
}

interface IProviderPreset {
  extension: string;
  wrapper: string;
  handler: string;
  validator: string;
}

export const WRAPPER_PROVIDERS: { [name: string]: IProviderPreset } = {
  bigquery: {
    extension: "wrappers",
    wrapper: "bigquery_wrapper",
    handler: "big_query_fdw_handler",
    validator: "big_query_fdw_validator"
  }
};

export interface IResolvedWrapper {
  extension: string;
  wrapper: string;
  handler?: string;
  validator?: string;
}

export function resolveWrapper(config: IWrapperConfig): IResolvedWrapper {
  if (config.provider) {
    const preset = WRAPPER_PROVIDERS[config.provider];
    if (!preset) {
      throw new Error(
        `Unknown wrapper provider "${config.provider}". Supported providers: ${Object.keys(
          WRAPPER_PROVIDERS
        ).join(", ")}.`
      );
    }
    return preset;
  }
  if (!config.wrapper) {
    throw new Error(
      `wrapper "${config.name}" must set either "provider" or an explicit "wrapper" extension name.`
    );
  }
  if (!config.handler || !config.validator) {
    throw new Error(
      `wrapper "${config.name}" without a "provider" preset must also set "handler" and "validator".`
    );
  }
  return {
    extension: config.wrapper,
    wrapper: config.wrapper,
    handler: config.handler,
    validator: config.validator
  };
}

export class Wrapper extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IWrapperConfig;

  constructor(session: Session, config: IWrapperConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
      validateTarget: true
    });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    const resolved = resolveWrapper(this.config);

    const serverOptionsMap = { ...(this.config.serverOptions || this.config.options || {}) };
    if (this.config.credential && this.config.credential.saKeyId) {
      serverOptionsMap.sa_key_id = this.config.credential.saKeyId;
    }
    const optionsArray = Object.entries(serverOptionsMap).map(([k, v]) => `${k} '${v}'`);
    const optionsStr = optionsArray.length > 0 ? ` options (${optionsArray.join(", ")})` : "";

    const queries = [`create extension if not exists "${resolved.extension}" cascade`];
    if (resolved.handler && resolved.validator) {
      queries.push(
        `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = '${resolved.wrapper}') then create foreign data wrapper ${resolved.wrapper} handler ${resolved.handler} validator ${resolved.validator}; end if; end $$`
      );
    }
    queries.push(`drop server if exists "${this.config.server}" cascade`);
    queries.push(
      `create server "${this.config.server}" foreign data wrapper "${resolved.wrapper}"${optionsStr}`
    );

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS for the new test. The pre-existing `"compiling supabase custom actions"` test (uses `wrapper: "bigquery_fdw"` with no provider) now throws on missing handler/validator — migrated in Task 4; that failure is expected for now.

- [ ] **Step 5: Commit**

```bash
git add core/actions/wrapper.ts core/actions/supabase_actions_test.ts
git commit -m "feat(wrapper): provider presets + correct FDW/server DDL + sa_key_id"
```

---

### Task 2: Ref-able `ForeignTable` action

**Files:**
- Create: `core/actions/foreign_table.ts`
- Modify: `core/actions/index.ts`, `core/session.ts`
- Test: `core/actions/supabase_actions_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  test("foreignTable emits ref-able create foreign table depending on the server", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: supabase`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `
      wrapper({
        name: "bq_setup",
        provider: "bigquery",
        server: "bq_server",
        serverOptions: { project_id: "bigquery-public-data", dataset_id: "geo_us_boundaries" },
        credential: { saKeyId: "00000000-0000-0000-0000-000000000000" },
        foreignTables: [
          {
            name: "zip_codes",
            schema: "bq_ext",
            options: { table: "zip_codes", location: "US" },
            columns: { zip_code: "text", internal_point_lat: "float8", internal_point_lon: "float8" }
          }
        ]
      });
      `
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/use_zip.sqlx"),
      `config { type: "view", schema: "bq_ext" }\nSELECT zip_code FROM \${ref("zip_codes")}`
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(result.compile.compiledGraph.operations);
    const ft = operations.find((op) => op.target.name === "zip_codes");
    expect(ft).to.exist;
    expect(ft.target.schema).equals("bq_ext");
    expect(ft.hasOutput).equals(true);
    expect(ft.dependencyTargets.map((t) => t.name)).deep.equals(["bq_setup"]);
    expect(ft.queries).deep.equals([
      'drop foreign table if exists "bq_ext"."zip_codes"',
      `create foreign table "bq_ext"."zip_codes" ("zip_code" text, "internal_point_lat" float8, "internal_point_lon" float8) server "bq_server" options (table 'zip_codes', location 'US')`
    ]);
    const views = asPlainObject(result.compile.compiledGraph.tables);
    const view = views.find((t) => t.target.name === "use_zip");
    expect(view.dependencyTargets.map((t) => t.name)).deep.equals(["zip_codes"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `session.wrapper()` does not yet create `ForeignTable` actions.

- [ ] **Step 3: Write `core/actions/foreign_table.ts`**

```typescript
import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IForeignTableConfig {
  name: string;
  schema?: string;
  server: string;
  options?: { [key: string]: string };
  columns?: { [key: string]: string };
  dependsOn: string;
  filename?: string;
}

export class ForeignTable extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IForeignTableConfig;

  constructor(session: Session, config: IForeignTableConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name, schema: config.schema });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
      validateTarget: true
    });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";
    this.proto.hasOutput = true;
    this.proto.dependencyTargets = [sqlanvil.Target.create({ name: config.dependsOn })];
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    const qualified = this.config.schema
      ? `"${this.config.schema}"."${this.config.name}"`
      : `"${this.config.name}"`;

    const cols = Object.entries(this.config.columns || {}).map(([c, t]) => `"${c}" ${t}`);
    const colsStr = cols.length > 0 ? ` (${cols.join(", ")})` : "";

    const optionsArray = Object.entries(this.config.options || {}).map(([k, v]) => `${k} '${v}'`);
    const optionsStr = optionsArray.length > 0 ? ` options (${optionsArray.join(", ")})` : "";

    this.proto.queries = [
      `drop foreign table if exists ${qualified}`,
      `create foreign table ${qualified}${colsStr} server "${this.config.server}"${optionsStr}`
    ];

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
```

- [ ] **Step 4: Wire exports and session expansion**

`core/actions/index.ts` — alongside the existing `Wrapper` import/export and the `Action` union:

```typescript
import { ForeignTable } from "sa/core/actions/foreign_table";
export { ForeignTable, IForeignTableConfig } from "sa/core/actions/foreign_table";
// add `| ForeignTable` to the `Action` union type
```

`core/session.ts`:
1. Add `ForeignTable` and `IForeignTableConfig` to the import from `sa/core/actions` (the line importing `Wrapper, IWrapperConfig, …`).
2. Replace the `public wrapper(...)` method body:

```typescript
  public wrapper(config: IWrapperConfig): Wrapper {
    const filename = utils.getCallerFile(this.rootDir);
    const wrapper = new Wrapper(this, { filename, ...config });
    this.actions.push(wrapper);
    (config.foreignTables || []).forEach(ft => {
      const foreignTable = new ForeignTable(this, {
        filename,
        name: ft.name,
        schema: ft.schema,
        server: config.server,
        options: ft.options,
        columns: ft.columns,
        dependsOn: config.name
      });
      this.actions.push(foreignTable);
    });
    return wrapper;
  }
```

3. Add `action instanceof ForeignTable ||` to the `operations:` `compileGraphChunk(...)` filter (next to `Wrapper`).

- [ ] **Step 5: Run test to verify it passes**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS for the new `foreignTable` test (the old test still fails until Task 4).

- [ ] **Step 6: Commit**

```bash
git add core/actions/foreign_table.ts core/actions/index.ts core/session.ts core/actions/supabase_actions_test.ts
git commit -m "feat(wrapper): ref-able foreign tables via ForeignTable action + session expansion"
```

---

### Task 3: Compile-error coverage

**Files:**
- Test: `core/actions/supabase_actions_test.ts`

- [ ] **Step 1: Write the tests**

```typescript
  test("wrapper rejects unknown provider", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: supabase`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `wrapper({ name: "x", provider: "snowflake", server: "s" });`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errors = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errors.join("\n")).to.match(/Unknown wrapper provider "snowflake"/);
  });

  test("wrapper without provider requires handler and validator", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: supabase`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `wrapper({ name: "x", wrapper: "some_fdw", server: "s" });`
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errors = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errors.join("\n")).to.match(/must also set "handler" and "validator"/);
  });
```

- [ ] **Step 2: Run test**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS. If a thrown error crashes compilation instead of landing in `compilationErrors`, read how `compileGraphChunk` in `core/session.ts` captures operation errors and mirror it so `Wrapper.compile()` errors surface into `compilationErrors`.

- [ ] **Step 3: Commit**

```bash
git add core/actions/supabase_actions_test.ts
git commit -m "test(wrapper): compile-error coverage for provider/handler validation"
```

---

### Task 4: Migrate the pre-existing wrapper test

**Files:**
- Modify: `core/actions/supabase_actions_test.ts` (the original `"compiling supabase custom actions"` test)

- [ ] **Step 1: Update the wrapper call**

Replace `wrapper({ name: "bq_wrapper", wrapper: "bigquery_fdw", server: "bq_server", options: { project_id: "my-gcp-project" } });` with:

```javascript
      wrapper({
        name: "bq_wrapper",
        provider: "bigquery",
        server: "bq_server",
        serverOptions: { project_id: "my-gcp-project" }
      });
```

- [ ] **Step 2: Update its assertion**

```typescript
    expect(wrapperOp.queries).deep.equals([
      'create extension if not exists "wrappers" cascade',
      `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'bigquery_wrapper') then create foreign data wrapper bigquery_wrapper handler big_query_fdw_handler validator big_query_fdw_validator; end if; end $$`,
      'drop server if exists "bq_server" cascade',
      `create server "bq_server" foreign data wrapper "bigquery_wrapper" options (project_id 'my-gcp-project')`
    ]);
```

- [ ] **Step 3: Run the full suite**

Run: `./scripts/docker-bazel test //core/actions:supabase_actions_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS — all tests.

- [ ] **Step 4: Run the broader core test set**

Run: `./scripts/docker-bazel test //core/... --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS. Update `core/main_test.ts`/session snapshot tests only where the new `ForeignTable` action legitimately changes counts/types.

- [ ] **Step 5: Commit**

```bash
git add core/actions/supabase_actions_test.ts
git commit -m "test(wrapper): migrate existing test to provider preset contract"
```

---

## Phase 2 — The example project

> The example uses the JS API for the FDW bridge and SQLX for everything else. It must **compile without credentials** (placeholder `saKeyId`), so it works as a CI compile-check; a live run needs a real Supabase project + Vault secret + GCP service account (README).

### Task 5: Scaffold project settings

**Files:**
- Create: `examples/supabase_bigquery_mailing_list/workflow_settings.yaml`
- Create: `examples/supabase_bigquery_mailing_list/.df-credentials.example.json`

- [ ] **Step 1: Write `workflow_settings.yaml`**

```yaml
warehouse: supabase
defaultDataset: public
defaultAssertionDataset: sqlanvil_assertions
sqlanvilCoreVersion: 1.0.2
vars:
  target_zip: "94110"
  radius_miles: "25"
  purchased_since_days: "365"
  bq_sa_key_id: "REPLACE_WITH_VAULT_SECRET_ID"
```

- [ ] **Step 2: Write `.df-credentials.example.json`**

```json
{
  "host": "aws-1-<region>.pooler.supabase.com",
  "port": 5432,
  "database": "postgres",
  "user": "postgres.<your-project-ref>",
  "password": "<your-db-password>",
  "sslMode": "require",
  "defaultSchema": "public"
}
```

- [ ] **Step 3: Commit**

```bash
git add examples/supabase_bigquery_mailing_list/workflow_settings.yaml examples/supabase_bigquery_mailing_list/.df-credentials.example.json
git commit -m "feat(example): scaffold supabase_bigquery_mailing_list settings"
```

---

### Task 6: FDW source + staging models

**Files:**
- Create: `examples/supabase_bigquery_mailing_list/definitions/sources/bigquery_zip_codes.js`
- Create: `examples/supabase_bigquery_mailing_list/definitions/staging/stg_zip_codes.sqlx`
- Create: `examples/supabase_bigquery_mailing_list/definitions/staging/zip_codes_cache.sqlx`

- [ ] **Step 1: Write `bigquery_zip_codes.js`**

```javascript
// Cross-warehouse bridge: a live BigQuery Foreign Data Wrapper over Google's
// public ZIP code geo data. One wrapper() call sets up the FDW + server and
// declares a ref()-able foreign table.
wrapper({
  name: "bq_setup",
  provider: "bigquery",
  server: "bq_geo_server",
  serverOptions: {
    project_id: "bigquery-public-data",
    dataset_id: "geo_us_boundaries"
  },
  credential: { saKeyId: dataform.projectConfig.vars.bq_sa_key_id },
  foreignTables: [
    {
      name: "zip_codes",
      schema: "bq_ext",
      options: { table: "zip_codes", location: "US" },
      columns: {
        zip_code: "text",
        internal_point_lat: "float8",
        internal_point_lon: "float8"
      }
    }
  ]
});
```

- [ ] **Step 2: Write `stg_zip_codes.sqlx`**

```sql
config {
  type: "view",
  schema: "bq_ext",
  description: "Shaped view over the live BigQuery zip_codes foreign table."
}

SELECT
  zip_code,
  internal_point_lat AS lat,
  internal_point_lon AS lon
FROM ${ref("zip_codes")}
WHERE internal_point_lat IS NOT NULL
  AND internal_point_lon IS NOT NULL
```

- [ ] **Step 3: Write `zip_codes_cache.sqlx`**

```sql
config {
  type: "table",
  schema: "public",
  description: "Materializes BigQuery zip centroids into Supabase so downstream joins don't re-hit BigQuery."
}

SELECT zip_code, lat, lon
FROM ${ref("stg_zip_codes")}
```

- [ ] **Step 4: Commit**

```bash
git add examples/supabase_bigquery_mailing_list/definitions/sources examples/supabase_bigquery_mailing_list/definitions/staging
git commit -m "feat(example): BigQuery FDW source + zip staging/cache"
```

---

### Task 7: Operational sample data

**Files:**
- Create: `examples/supabase_bigquery_mailing_list/definitions/operational/customers.sqlx`
- Create: `examples/supabase_bigquery_mailing_list/definitions/operational/sales_orders.sqlx`

- [ ] **Step 1: Write `customers.sqlx`**

```sql
config {
  type: "table",
  schema: "public",
  description: "Sample customers with mailing ZIP codes."
}

SELECT * FROM (
  VALUES
    (1, 'amy@example.com',   '94110'),
    (2, 'ben@example.com',   '94103'),
    (3, 'cara@example.com',  '95014'),
    (4, 'dan@example.com',   '10001'),
    (5, 'erin@example.com',  '94609')
) AS t(customer_id, email, zip)
```

- [ ] **Step 2: Write `sales_orders.sqlx`**

```sql
config {
  type: "table",
  schema: "public",
  description: "Sample sales orders; order_date drives the recency filter."
}

SELECT * FROM (
  VALUES
    (101, 1, DATE '2026-03-01'),
    (102, 2, DATE '2026-05-15'),
    (103, 3, DATE '2025-12-20'),
    (104, 4, DATE '2026-04-10'),
    (105, 5, DATE '2024-01-05')
) AS t(order_id, customer_id, order_date)
```

- [ ] **Step 3: Commit**

```bash
git add examples/supabase_bigquery_mailing_list/definitions/operational
git commit -m "feat(example): seed sample customers + sales_orders"
```

---

### Task 8: Marts + assertions

**Files:**
- Create: `examples/supabase_bigquery_mailing_list/definitions/marts/mailing_list_candidates.sqlx`
- Create: `examples/supabase_bigquery_mailing_list/definitions/marts/mailing_list.sqlx`
- Create: `examples/supabase_bigquery_mailing_list/definitions/assertions/assert_email_non_null.sqlx`
- Create: `examples/supabase_bigquery_mailing_list/definitions/assertions/assert_distance_non_negative.sqlx`

- [ ] **Step 1: Write `mailing_list_candidates.sqlx`**

```sql
config {
  type: "view",
  schema: "public",
  description: "Customers who purchased recently AND live within radius of the target ZIP."
}

WITH target AS (
  SELECT lat, lon
  FROM ${ref("zip_codes_cache")}
  WHERE zip_code = '${dataform.projectConfig.vars.target_zip}'
),
recent_customers AS (
  SELECT DISTINCT c.customer_id, c.email, c.zip
  FROM ${ref("customers")} AS c
  JOIN ${ref("sales_orders")} AS o ON o.customer_id = c.customer_id
  WHERE o.order_date >= CURRENT_DATE - INTERVAL '${dataform.projectConfig.vars.purchased_since_days} days'
)
SELECT
  rc.customer_id,
  rc.email,
  rc.zip,
  ROUND(
    (ST_Distance(
      ST_MakePoint(t.lon, t.lat)::geography,
      ST_MakePoint(z.lon, z.lat)::geography
    ) / 1609.34)::numeric, 1
  ) AS distance_miles
FROM recent_customers AS rc
JOIN ${ref("zip_codes_cache")} AS z ON z.zip_code = rc.zip
CROSS JOIN target AS t
WHERE ST_Distance(
        ST_MakePoint(t.lon, t.lat)::geography,
        ST_MakePoint(z.lon, z.lat)::geography
      ) <= ${dataform.projectConfig.vars.radius_miles}::float8 * 1609.34
```

- [ ] **Step 2: Write `mailing_list.sqlx`**

```sql
config {
  type: "table",
  schema: "public",
  description: "Final mailing list, ordered by proximity to the target ZIP."
}

SELECT customer_id, email, zip, distance_miles
FROM ${ref("mailing_list_candidates")}
ORDER BY distance_miles ASC
```

- [ ] **Step 3: Write `assert_email_non_null.sqlx`**

```sql
config {
  type: "assertion",
  schema: "sqlanvil_assertions"
}

SELECT * FROM ${ref("mailing_list")} WHERE email IS NULL
```

- [ ] **Step 4: Write `assert_distance_non_negative.sqlx`**

```sql
config {
  type: "assertion",
  schema: "sqlanvil_assertions"
}

SELECT * FROM ${ref("mailing_list")} WHERE distance_miles < 0
```

- [ ] **Step 5: Commit**

```bash
git add examples/supabase_bigquery_mailing_list/definitions/marts examples/supabase_bigquery_mailing_list/definitions/assertions
git commit -m "feat(example): mailing-list marts + assertions"
```

---

### Task 9: Compile-verify the example end-to-end

**Files:** none (verification)

- [ ] **Step 1: Compile with the locally-built CLI**

Run (from repo root): `./scripts/run compile examples/supabase_bigquery_mailing_list`
Expected: `Compiled N action(s)` with **zero compilation errors**; action list includes `bq_setup`, `zip_codes`, `stg_zip_codes`, `zip_codes_cache`, `customers`, `sales_orders`, `mailing_list_candidates`, `mailing_list`, and the two assertions.

- [ ] **Step 2: Confirm `ref()` resolution**

`stg_zip_codes` depends on `zip_codes`; `zip_codes` depends on `bq_setup`. If `ref("zip_codes")` is unresolved, revisit Task 2 (the `ForeignTable` target name/schema must match the `ref`).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "fix(example): resolve compile issues in mailing-list example"
```

---

### Task 10: Example README

**Files:**
- Create: `examples/supabase_bigquery_mailing_list/README.md`

- [ ] **Step 1: Write the README**

In order: (1) one-paragraph what/why; (2) the DAG diagram (from the spec data-flow section); (3) prerequisites — Supabase project (PostGIS + `wrappers` enabled), GCP service-account JSON with a billing-enabled project, `@sqlanvil/cli`; (4) the one-time Vault secret step:

```sql
-- Run once in the Supabase SQL editor; copy the returned id into
-- workflow_settings.yaml vars.bq_sa_key_id
select vault.create_secret('<paste service-account JSON>', 'bigquery_sa');
select id from vault.secrets where name = 'bigquery_sa';
```

(5) configure: copy `.df-credentials.example.json` → `.df-credentials.json`, fill pooler connection, set `vars.bq_sa_key_id`; (6) run: `sqlanvil run examples/supabase_bigquery_mailing_list --credentials .df-credentials.json`; (7) tweak `vars.target_zip` / `radius_miles`; (8) note the BigQuery wrapper requires Supabase (or self-managed Postgres with the `wrappers` extension).

- [ ] **Step 2: Commit**

```bash
git add examples/supabase_bigquery_mailing_list/README.md
git commit -m "docs(example): README for supabase_bigquery_mailing_list"
```

---

## Self-Review

**Spec coverage:**
- Extend `foreign_wrapper` (provider preset, server DDL fix, credential, foreign tables) → Tasks 1–2.
- `ref()`-able foreign tables → Task 2 (mechanism: Operation `hasOutput: true` + `dependencyTargets`).
- Credential strategy without handling key material → "reference a pre-existing Vault `sa_key_id`" (Task 1). Plain-Postgres user-mapping DDL emission is **out of scope for this plan** (the example is Supabase); the `credential.{user,password}` interface exists but is not yet emitted — flagged so it isn't mistaken for done.
- Error handling (unknown provider, missing handler/validator) → Task 3.
- Example with seeded operational data, PostGIS distance, vars → Tasks 5–8.
- Compiles without creds (CI-able) → Task 9.
- Docs → Task 10.

**Deviations from spec, flagged:**
- Spec showed `config { type: "foreignWrapper" }`; actual invocation is the JS API `wrapper({...})` (the existing action is JS-API only). Example uses a `.js` file accordingly.
- Spec's `credential.from` (env var → create secret) replaced by referencing a pre-existing Vault secret id, to keep SQLAnvil out of secret material. The one-time secret creation is a documented manual step (Task 10).
- No proto change (the JS API bypasses `ForeignWrapperConfig`); the `actions.yaml`/proto path is future work.

**Type consistency:** `IWrapperConfig` (Task 1) and `IForeignTableConfig` (Task 2) field names match their use in `session.wrapper()` (Task 2 Step 4). `WRAPPER_PROVIDERS`/`resolveWrapper` names match between definition and tests. `dataform.projectConfig.vars.*` is the var-access form across example files.

**Placeholder scan:** no TBD/TODO; every code step shows full code; the one intentional runtime artifact (`REPLACE_WITH_VAULT_SECRET_ID`) is documented in Task 10, not a plan gap.
