# `sqlanvil introspect` (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sqlanvil introspect <connection> <schema.table>` CLI command that reads a source table's columns + descriptions and writes a ready-to-use `declaration` `.sqlx` with `columnTypes` filled in — removing the hand-typing pain of connection-tagged declarations (Plan A).

**Architecture:** A pure core (type mapping + sqlx codegen + connection/credential resolution) is unit-tested with no network. Thin per-platform source readers (Postgres via `pg`/`information_schema`, BigQuery via `@google-cloud/bigquery` metadata) return a normalized column list; they're network code, verified manually/integration. The CLI command wires resolve → read → map → render → write. (Spec: `docs/superpowers/specs/2026-06-05-connections-design.md`, "`sqlanvil introspect`" section.)

**Tech Stack:** TypeScript, Bazel (via `./scripts/docker-bazel`), `pg`, `@google-cloud/bigquery` (both already deps), Mocha/Chai.

**Build/test note (macOS):** native Bazel broken — run via `./scripts/docker-bazel test <target> --jobs=2 --local_ram_resources=2048 --test_output=errors`. ES5 target: use `Object.keys().forEach`, no `for...of` over Maps/Object.entries. Work on branch `feat/introspect`. Depends on Plan A (already merged to `main`): `connections` config, `DeclarationConfig.connection`/`columnTypes`, the FDW bridge.

---

## File Structure

- Create `cli/api/commands/introspect.ts` — all introspect logic: `NormalizedColumn` type, `mapBigQueryType`/`mapPostgresType`, `renderDeclarationSqlx`, `resolveConnection`, the two source readers + `readSourceSchema` dispatch, and the `introspect()` orchestrator.
- Create `cli/api/commands/introspect_test.ts` — unit tests for the pure pieces (type maps, codegen, resolution, orchestrator with a stubbed reader).
- Modify `cli/api/BUILD` — add `introspect.ts` to the `api` ts_library srcs and `commands/introspect_test.ts` to the `tests` ts_test_suite srcs.
- Modify `cli/api/index.ts` (the `sa/cli/api` barrel) — export `introspect`.
- Modify `cli/index.ts` — register the `introspect` command.

---

## Task 1: Type mapping + normalized column model

**Files:** Create `cli/api/commands/introspect.ts`; Create `cli/api/commands/introspect_test.ts`; Modify `cli/api/BUILD`

- [ ] **Step 1: Write the failing test** (`cli/api/commands/introspect_test.ts`)

```typescript
import { expect } from "chai";

import { suite, test } from "sa/testing";
import { mapBigQueryType, mapPostgresType } from "sa/cli/api/commands/introspect";

suite("introspect type mapping", () => {
  test("maps common BigQuery types to Postgres types", () => {
    expect(mapBigQueryType("STRING")).equals("text");
    expect(mapBigQueryType("INT64")).equals("bigint");
    expect(mapBigQueryType("INTEGER")).equals("bigint");
    expect(mapBigQueryType("FLOAT64")).equals("float8");
    expect(mapBigQueryType("NUMERIC")).equals("numeric");
    expect(mapBigQueryType("BOOL")).equals("boolean");
    expect(mapBigQueryType("TIMESTAMP")).equals("timestamptz");
    expect(mapBigQueryType("DATE")).equals("date");
    expect(mapBigQueryType("BYTES")).equals("bytea");
    expect(mapBigQueryType("JSON")).equals("jsonb");
    expect(mapBigQueryType("GEOGRAPHY")).equals("text");
  });

  test("BigQuery mapping is case-insensitive", () => {
    expect(mapBigQueryType("string")).equals("text");
  });

  test("unmapped BigQuery type throws with the type name", () => {
    expect(() => mapBigQueryType("STRUCT")).to.throw(/Unmapped BigQuery type "STRUCT"/);
  });

  test("Postgres types pass through unchanged (lowercased/trimmed)", () => {
    expect(mapPostgresType("text")).equals("text");
    expect(mapPostgresType("  BIGINT ")).equals("bigint");
    expect(mapPostgresType("double precision")).equals("double precision");
  });
});
```

- [ ] **Step 2: Add the test to the BUILD suite + library**

In `cli/api/BUILD`: add `"commands/introspect.ts"` to the `api` `ts_library` `srcs`, and `"commands/introspect_test.ts"` to the `tests` `ts_test_suite` `srcs`. (Mirror how `commands/init.ts` / `commands/init_test.ts` are listed.)

- [ ] **Step 3: Run to verify it fails**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `introspect.ts` doesn't exist yet / functions undefined.

- [ ] **Step 4: Implement in `cli/api/commands/introspect.ts`**

```typescript
export interface NormalizedColumn {
  name: string;
  type: string;
  description?: string;
}

const BIGQUERY_TYPE_MAP: { [bq: string]: string } = {
  STRING: "text",
  BYTES: "bytea",
  INT64: "bigint",
  INTEGER: "bigint",
  FLOAT64: "float8",
  FLOAT: "float8",
  NUMERIC: "numeric",
  BIGNUMERIC: "numeric",
  BOOL: "boolean",
  BOOLEAN: "boolean",
  TIMESTAMP: "timestamptz",
  DATETIME: "timestamp",
  DATE: "date",
  TIME: "time",
  JSON: "jsonb",
  GEOGRAPHY: "text"
};

export function mapBigQueryType(bqType: string): string {
  const key = bqType.trim().toUpperCase();
  const mapped = BIGQUERY_TYPE_MAP[key];
  if (!mapped) {
    throw new Error(
      `Unmapped BigQuery type "${bqType}". Add it to BIGQUERY_TYPE_MAP or set the column type by hand.`
    );
  }
  return mapped;
}

export function mapPostgresType(pgType: string): string {
  // Postgres source -> Postgres warehouse: identity (information_schema already
  // reports a valid Postgres type name).
  return pgType.trim().toLowerCase();
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/api/commands/introspect.ts cli/api/commands/introspect_test.ts cli/api/BUILD
git commit -m "feat(introspect): source-type mapping (BigQuery->Postgres, Postgres identity)"
```

---

## Task 2: Declaration SQLX codegen

**Files:** Modify `cli/api/commands/introspect.ts`, `cli/api/commands/introspect_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { renderDeclarationSqlx } from "sa/cli/api/commands/introspect";

suite("introspect codegen", () => {
  test("renders a declaration with columnTypes and descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "bq",
      schema: "geo_us_boundaries",
      name: "zip_codes",
      columns: [
        { name: "zip_code", type: "text", description: "5-digit ZIP" },
        { name: "internal_point_lat", type: "float8" }
      ]
    });
    expect(out).equals(
      `config {
  type: "declaration",
  connection: "bq",
  schema: "geo_us_boundaries",
  name: "zip_codes",
  columnTypes: {
    zip_code: "text",
    internal_point_lat: "float8"
  },
  columns: {
    zip_code: "5-digit ZIP"
  }
}
`
    );
  });

  test("omits the columns block when there are no descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "bq",
      name: "t",
      columns: [{ name: "id", type: "bigint" }]
    });
    expect(out).equals(
      `config {
  type: "declaration",
  connection: "bq",
  name: "t",
  columnTypes: {
    id: "bigint"
  }
}
`
    );
    expect(out).not.to.match(/columns:/);
  });

  test("quotes non-identifier column names and escapes quotes in descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "c",
      name: "t",
      columns: [{ name: "weird-name", type: "text", description: `has "quote"` }]
    });
    expect(out).to.contain(`"weird-name": "text"`);
    expect(out).to.contain(`"weird-name": "has \\"quote\\""`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `renderDeclarationSqlx` undefined.

- [ ] **Step 3: Implement (append to `cli/api/commands/introspect.ts`)**

```typescript
export interface RenderDeclarationOptions {
  connection: string;
  schema?: string;
  name: string;
  columns: NormalizedColumn[];
}

function keyToken(name: string): string {
  // Bare key if a valid JS identifier, else a double-quoted string key.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderDeclarationSqlx(opts: RenderDeclarationOptions): string {
  const lines: string[] = [];
  lines.push("config {");
  lines.push(`  type: "declaration",`);
  lines.push(`  connection: ${quote(opts.connection)},`);
  if (opts.schema) {
    lines.push(`  schema: ${quote(opts.schema)},`);
  }
  lines.push(`  name: ${quote(opts.name)},`);

  const typeLines = opts.columns.map(c => `    ${keyToken(c.name)}: ${quote(c.type)}`);
  const described = opts.columns.filter(c => c.description);
  // columnTypes always present; a trailing comma after its block only if columns block follows.
  lines.push(`  columnTypes: {`);
  lines.push(typeLines.join(",\n"));
  lines.push(described.length > 0 ? `  },` : `  }`);

  if (described.length > 0) {
    const descLines = described.map(c => `    ${keyToken(c.name)}: ${quote(c.description!)}`);
    lines.push(`  columns: {`);
    lines.push(descLines.join(",\n"));
    lines.push(`  }`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/api/commands/introspect.ts cli/api/commands/introspect_test.ts
git commit -m "feat(introspect): render declaration sqlx (columnTypes + descriptions)"
```

---

## Task 3: Connection + credential resolution

**Files:** Modify `cli/api/commands/introspect.ts`, `cli/api/commands/introspect_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import * as fs from "fs-extra";
import * as path from "path";
import { TmpDirFixture } from "sa/testing/fixtures";
import { resolveConnection } from "sa/cli/api/commands/introspect";

suite("introspect connection resolution", ({ afterEach }) => {
  const tmp = new TmpDirFixture(afterEach);

  test("resolves a connection's definition and credentials", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres\n    host: db.example.com\n    port: 5432\n    database: legacy`
    );
    fs.writeFileSync(
      path.join(dir, ".df-credentials.json"),
      JSON.stringify({ wh: { password: "x" }, legacy: { user: "u", password: "p" } })
    );
    const resolved = resolveConnection(dir, "legacy");
    expect(resolved.definition.platform).equals("postgres");
    expect(resolved.definition.host).equals("db.example.com");
    expect(resolved.credentials.user).equals("u");
    expect(resolved.credentials.password).equals("p");
  });

  test("errors on unknown connection", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ wh: {} }));
    expect(() => resolveConnection(dir, "nope")).to.throw(/Unknown connection "nope"/);
  });

  test("errors when credentials for the connection are missing", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ wh: {} }));
    expect(() => resolveConnection(dir, "legacy")).to.throw(/No credentials for connection "legacy"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `resolveConnection` undefined.

- [ ] **Step 3: Implement (append to `cli/api/commands/introspect.ts`)**

```typescript
import * as fs from "fs-extra";
import * as path from "path";

import { readConfigFromWorkflowSettings } from "sa/cli/api/utils";

export interface ResolvedConnection {
  name: string;
  definition: any; // ConnectionConfig shape: { platform, project, dataset, saKeyId, host, port, database, defaultSchema }
  credentials: any; // secrets from .df-credentials.json for this connection
}

export function resolveConnection(projectDir: string, connectionName: string): ResolvedConnection {
  const workflowSettings = readConfigFromWorkflowSettings(path.resolve(projectDir));
  const definition = workflowSettings?.connections?.[connectionName];
  if (!definition) {
    throw new Error(
      `Unknown connection "${connectionName}". Define it under \`connections:\` in workflow_settings.yaml.`
    );
  }
  const credsPath = path.join(path.resolve(projectDir), ".df-credentials.json");
  if (!fs.existsSync(credsPath)) {
    throw new Error(`Missing .df-credentials.json in ${projectDir}.`);
  }
  const allCreds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  const credentials = allCreds[connectionName];
  if (!credentials) {
    throw new Error(
      `No credentials for connection "${connectionName}" in .df-credentials.json ` +
        `(expected a top-level "${connectionName}" key).`
    );
  }
  return { name: connectionName, definition, credentials };
}
```

(Confirm the import path `sa/cli/api/utils` and that `readConfigFromWorkflowSettings` returns an object whose `.connections` map carries the keys as authored. If it returns a typed proto, `.connections` is still index-accessible.)

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/api/commands/introspect.ts cli/api/commands/introspect_test.ts
git commit -m "feat(introspect): resolve connection definition + per-connection credentials"
```

---

## Task 4: Source schema readers (Postgres + BigQuery) + orchestrator

**Files:** Modify `cli/api/commands/introspect.ts`, `cli/api/commands/introspect_test.ts`

> Readers touch the network, so they are NOT unit-tested here (verified manually in Task 5). The orchestrator IS unit-tested by injecting a fake reader.

- [ ] **Step 1: Write the failing test (orchestrator with injected reader)**

```typescript
import { introspectToSqlx } from "sa/cli/api/commands/introspect";

suite("introspect orchestrator", ({ afterEach }) => {
  const tmp2 = new TmpDirFixture(afterEach);

  test("maps source columns and renders sqlx via an injected reader", async () => {
    const dir = tmp2.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ wh: {}, bq: { credentials: "{}" } }));

    const fakeReader = async () => [
      { name: "zip_code", type: "STRING", description: "5-digit ZIP" },
      { name: "internal_point_lat", type: "FLOAT64" }
    ];
    const sqlx = await introspectToSqlx(dir, "bq", "geo_us_boundaries.zip_codes", { reader: fakeReader });
    expect(sqlx).to.contain(`connection: "bq"`);
    expect(sqlx).to.contain(`zip_code: "text"`);
    expect(sqlx).to.contain(`internal_point_lat: "float8"`);
    expect(sqlx).to.contain(`zip_code: "5-digit ZIP"`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: FAIL — `introspectToSqlx` undefined.

- [ ] **Step 3: Implement readers + orchestrator (append to `cli/api/commands/introspect.ts`)**

```typescript
import * as pg from "pg";
import { BigQuery } from "@google-cloud/bigquery";

// A reader returns the source table's columns with the SOURCE platform's type names.
export type SchemaReader = (
  resolved: ResolvedConnection,
  sourceSchema: string,
  table: string
) => Promise<NormalizedColumn[]>;

export const readPostgresSchema: SchemaReader = async (resolved, sourceSchema, table) => {
  const c = resolved.credentials;
  const client = new pg.Client({
    host: c.host || resolved.definition.host,
    port: Number(c.port || resolved.definition.port || 5432),
    database: c.database || resolved.definition.database,
    user: c.user,
    password: c.password,
    ssl: c.sslMode && c.sslMode !== "disable" ? { rejectUnauthorized: false } : undefined
  });
  await client.connect();
  try {
    const res = await client.query(
      `select c.column_name, c.data_type,
              col_description(format('%I.%I', c.table_schema, c.table_name)::regclass::oid, c.ordinal_position) as description
       from information_schema.columns c
       where c.table_schema = $1 and c.table_name = $2
       order by c.ordinal_position`,
      [sourceSchema, table]
    );
    return res.rows.map(r => ({
      name: r.column_name,
      type: mapPostgresType(r.data_type),
      description: r.description || undefined
    }));
  } finally {
    await client.end();
  }
};

export const readBigQuerySchema: SchemaReader = async (resolved, sourceSchema, table) => {
  // The source service-account key JSON lives in .df-credentials.json under `credentials`.
  const keyJson = resolved.credentials.credentials;
  const bq = new BigQuery({
    projectId: resolved.definition.project,
    credentials: typeof keyJson === "string" ? JSON.parse(keyJson) : keyJson
  });
  const [metadata] = await bq.dataset(sourceSchema).table(table).getMetadata();
  const fields: any[] = (metadata.schema && metadata.schema.fields) || [];
  return fields.map(f => ({
    name: f.name,
    type: mapBigQueryType(f.type),
    description: f.description || undefined
  }));
};

function defaultReaderFor(platform: string): SchemaReader {
  if (platform === "bigquery") {
    return readBigQuerySchema;
  }
  if (platform === "postgres" || platform === "supabase") {
    return readPostgresSchema;
  }
  throw new Error(`introspect does not support source platform "${platform}".`);
}

function splitTableRef(tableRef: string): { schema?: string; table: string } {
  const dot = tableRef.indexOf(".");
  return dot === -1
    ? { table: tableRef }
    : { schema: tableRef.slice(0, dot), table: tableRef.slice(dot + 1) };
}

export interface IntrospectOptions {
  reader?: SchemaReader; // for tests / injection
}

export async function introspectToSqlx(
  projectDir: string,
  connectionName: string,
  tableRef: string,
  options: IntrospectOptions = {}
): Promise<string> {
  const resolved = resolveConnection(projectDir, connectionName);
  const { schema, table } = splitTableRef(tableRef);
  const reader = options.reader || defaultReaderFor(resolved.definition.platform);
  const columns = await reader(resolved, schema || resolved.definition.dataset || resolved.definition.defaultSchema, table);
  if (columns.length === 0) {
    throw new Error(`Source table "${tableRef}" on connection "${connectionName}" has no columns (does it exist?).`);
  }
  return renderDeclarationSqlx({ connection: connectionName, schema, name: table, columns });
}
```

Note: the readers return columns whose `type` is ALREADY mapped (the reader calls `mapBigQueryType`/`mapPostgresType`). The orchestrator's injected fake in the test returns SOURCE types (`STRING`), so the orchestrator must map them — adjust: make the orchestrator NOT re-map (readers map) BUT the test's fake returns raw source types. To keep one mapping site, change the test fake to return already-mapped types, OR have readers return RAW types and the orchestrator map. **Decision: readers return RAW source types; the orchestrator maps** (single mapping site, and the injected-reader test exercises mapping). Update the readers above to return `type: f.type` (raw) / `type: r.data_type` (raw), and map in `introspectToSqlx`:

```typescript
  const rawColumns = await reader(resolved, schema || resolved.definition.dataset || resolved.definition.defaultSchema, table);
  const mapType = resolved.definition.platform === "bigquery" ? mapBigQueryType : mapPostgresType;
  const columns = rawColumns.map(c => ({ name: c.name, type: mapType(c.type), description: c.description }));
```
and in `readPostgresSchema`/`readBigQuerySchema` set `type: r.data_type` / `type: f.type` (raw, no map call). This matches the test (fake returns `STRING`/`FLOAT64`, orchestrator maps to `text`/`float8`).

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/docker-bazel test //cli/api:commands/introspect_test --jobs=2 --local_ram_resources=2048 --test_output=errors`
Expected: PASS (orchestrator test). The readers compile but are exercised manually in Task 5.

- [ ] **Step 5: Commit**

```bash
git add cli/api/commands/introspect.ts cli/api/commands/introspect_test.ts
git commit -m "feat(introspect): pg + bigquery schema readers and orchestrator (mapping at one site)"
```

---

## Task 5: CLI command wiring + manual verification + docs

**Files:** Modify `cli/api/index.ts`, `cli/index.ts`; docs

- [ ] **Step 1: Export `introspect` from the api barrel**

In `cli/api/index.ts` (the `sa/cli/api` module that `cli/index.ts` imports from), add an export so `introspectToSqlx` (and the readers) are reachable. Mirror how `init`/`compile` are exported. Confirm the exact barrel file by `grep -rn "export .* from \"sa/cli/api/commands/init\"" cli/api`.

- [ ] **Step 2: Register the command in `cli/index.ts`**

Add a command object to the `commands` array (mirror the `init` command shape), with two required positionals (`connection`, `tableRef`) and the existing `projectDirOption`, plus an `--output` option. Use the existing `print`/`printSuccess` helpers:

```typescript
      {
        format: `introspect <connection> <tableRef> [${projectDirOption.name}]`,
        description:
          "Read a source table's schema from a connection and write a declaration .sqlx with columnTypes.",
        positionalOptions: [
          { name: "connection", option: { describe: "Connection name (from workflow_settings.yaml connections)." } },
          { name: "tableRef", option: { describe: "Source table as schema.table (or just table)." } },
          projectDirOption
        ],
        options: [
          {
            name: "output",
            option: { describe: "File to write the declaration .sqlx to. Prints to stdout if omitted." }
          }
        ],
        processFn: async argv => {
          const projectDir = argv[projectDirOption.name];
          const sqlx = await introspectToSqlx(projectDir, argv.connection, argv.tableRef);
          const output = argv.output;
          if (output) {
            const fs = require("fs-extra");
            fs.writeFileSync(output, sqlx);
            printSuccess(`Wrote declaration to ${output}`);
          } else {
            print(sqlx);
          }
          return 0;
        }
      },
```

Import `introspectToSqlx` at the top of `cli/index.ts` from `sa/cli/api` (via the barrel). Confirm `print`/`printSuccess` names match what the file already uses (grep them).

- [ ] **Step 3: Build the CLI**

Run: `./scripts/docker-bazel build //packages/@sqlanvil/cli:bin --jobs=2 --local_ram_resources=2048`
Expected: builds successfully. Then `./scripts/docker-bazel run //packages/@sqlanvil/cli:bin --jobs=2 --local_ram_resources=2048 -- introspect --help` should show the new command (or run `help introspect`).

- [ ] **Step 4: Manual end-to-end verification (network)**

Document in the commit message that live verification requires real credentials. If a local Postgres is available (`./tools/postgres/run-postgres-db.sh`), create a table, add a `legacy` postgres connection + creds, and run `introspect legacy public.<table>` — confirm the printed sqlx has correct `columnTypes`. (No automated network test; the pure pipeline is covered by Tasks 1-4.)

- [ ] **Step 5: Docs**

Add an `## Introspecting source schemas` section to `sqlanvil-com/src/content/docs/docs/guides/foreign-wrappers.md` (separate repo `~/projects-ivan/sqlanvil-com`) showing `sqlanvil introspect <connection> <schema.table> --output definitions/sources/<name>.sqlx`, and update the connections design's "out of scope" note. (Docs-site changes build + deploy separately; this step is optional to defer.)

- [ ] **Step 6: Commit**

```bash
git add cli/index.ts cli/api/index.ts
git commit -m "feat(introspect): register the introspect CLI command"
```

---

## Self-Review

**Spec coverage:**
- `sqlanvil introspect <connection> <schema.table>` command → Task 5.
- Connects to source via connection credentials → Task 4 readers + Task 3 resolution.
- Maps source types → warehouse dialect (BigQuery→PG map; PG identity) → Task 1, applied once in the orchestrator (Task 4).
- Writes/updates a declaration `.sqlx` with `columnTypes` + descriptions → Task 2 codegen, Task 5 `--output`.
- Network-only at introspect time; compile stays offline → readers live only in the introspect path.
- Out of scope (unchanged): EXTERNAL_QUERY, extract-load.

**Type consistency:** `NormalizedColumn {name,type,description?}` used by readers, orchestrator, and codegen. `SchemaReader` signature `(ResolvedConnection, sourceSchema, table) => Promise<NormalizedColumn[]>` consistent between `readPostgresSchema`/`readBigQuerySchema`/the injected fake. `resolveConnection` → `ResolvedConnection {name, definition, credentials}` consumed by readers + orchestrator. Mapping happens once (orchestrator), readers return RAW source types (Task 4 Step 3 decision).

**Placeholder scan:** all steps have concrete code. Inline confirmations required (not gaps): the `sa/cli/api` barrel file name/exports; `print`/`printSuccess` helper names; that `readConfigFromWorkflowSettings` exposes `.connections`. Each is a one-line grep the implementer runs.

**Decision locked (Task 4):** readers return raw source type strings; the orchestrator maps once. The reader implementations in Step 3 must use `type: r.data_type` / `type: f.type` (raw), per the Step 3 note.
