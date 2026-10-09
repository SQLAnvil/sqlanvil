import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { asPlainObject, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import {
  coreExecutionRequestFromPath,
  runMainInVm,
  VALID_WORKFLOW_SETTINGS_YAML,
} from "sa/testing/run_core";
import { sqlanvil } from "sa/protos/ts";

suite("supabase actions", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("compiling supabase custom actions", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: postgres`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));

    // Write a table definitions file
    fs.writeFileSync(
      path.join(projectDir, "definitions/users.js"),
      `publish("users", { type: "table" }).query(ctx => "SELECT 1")`,
    );

    // Write a JS file configuring our new Supabase actions
    fs.writeFileSync(
      path.join(projectDir, "definitions/supabase.js"),
      `
      rlsPolicy({
        table: "users",
        name: "select_policy",
        command: "SELECT",
        roles: ["authenticated"],
        using: "true"
      });

      realtimePublication({
        table: "users",
        name: "supabase_realtime"
      });

      wrapper({
        name: "bq_wrapper",
        provider: "bigquery",
        server: "bq_server",
        serverOptions: { project_id: "my-gcp-project" }
      });

      vectorIndex({
        name: "user_embeddings_idx",
        table: "users",
        column: "embedding",
        indexType: "hnsw",
        params: {
          opclass: "vector_cosine_ops",
          m: "16"
        }
      });
      `,
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);

    const operations = asPlainObject(result.compile.compiledGraph.operations);

    // Verify RLS policy operation exists and generated correct queries
    const rlsOp = operations.find((op: any) => op.target.name === "users_policy_select_policy");
    expect(rlsOp).to.exist;
    expect(rlsOp.queries).deep.equals([
      'alter table "defaultProject"."defaultDataset"."users" enable row level security',
      'drop policy if exists "select_policy" on "defaultProject"."defaultDataset"."users"',
      'create policy "select_policy" on "defaultProject"."defaultDataset"."users" for SELECT to authenticated USING (true)',
    ]);

    // Verify Realtime publication operation exists and generated correct queries
    const realtimeOp = operations.find(
      (op: any) => op.target.name === "users_realtime_supabase_realtime",
    );
    expect(realtimeOp).to.exist;
    expect(realtimeOp.queries).deep.equals([
      'alter table "defaultProject"."defaultDataset"."users" replica identity full',
      'alter publication supabase_realtime add table "defaultProject"."defaultDataset"."users"',
    ]);

    // Verify FDW Wrapper operation exists and generated correct queries
    const wrapperOp = operations.find((op: any) => op.target.name === "bq_wrapper");
    expect(wrapperOp).to.exist;
    expect(wrapperOp.queries).deep.equals([
      'create extension if not exists "wrappers" cascade',
      `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'bigquery_wrapper') then create foreign data wrapper bigquery_wrapper handler big_query_fdw_handler validator big_query_fdw_validator; end if; end $$`,
      'drop server if exists "bq_server" cascade',
      `create server "bq_server" foreign data wrapper "bigquery_wrapper" options (project_id 'my-gcp-project')`,
    ]);

    // Verify Vector index operation exists and generated correct queries
    const vectorOp = operations.find(
      (op: any) => op.target.name === "users_idx_user_embeddings_idx",
    );
    expect(vectorOp).to.exist;
    expect(vectorOp.queries).deep.equals([
      "create extension if not exists vector cascade",
      'drop index if exists "user_embeddings_idx"',
      'create index "user_embeddings_idx" on "defaultProject"."defaultDataset"."users" using hnsw ("embedding" vector_cosine_ops) with (m = 16)',
    ]);
  });

  test("wrapper still accepts the legacy options field for server options", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: supabase`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `
      wrapper({
        name: "bq_legacy",
        provider: "bigquery",
        server: "bq_legacy_server",
        options: { project_id: "my-gcp-project" }
      });
      `,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(result.compile.compiledGraph.operations);
    const setup = operations.find((op) => op.target.name === "bq_legacy");
    expect(setup).to.exist;
    expect(setup.queries).deep.equals([
      'create extension if not exists "wrappers" cascade',
      `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'bigquery_wrapper') then create foreign data wrapper bigquery_wrapper handler big_query_fdw_handler validator big_query_fdw_validator; end if; end $$`,
      'drop server if exists "bq_legacy_server" cascade',
      `create server "bq_legacy_server" foreign data wrapper "bigquery_wrapper" options (project_id 'my-gcp-project')`,
    ]);
  });

  test("wrapper with bigquery provider emits correct FDW + server DDL", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: supabase`,
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
      `,
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
      `create server "bq_server" foreign data wrapper "bigquery_wrapper" options (project_id 'bigquery-public-data', dataset_id 'geo_us_boundaries', sa_key_id '00000000-0000-0000-0000-000000000000')`,
    ]);
  });

  test("declare() postgres source emits a postgres_fdw bridge with a credential-injected user mapping", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: public
warehouse: supabase
connections:
  pg_src:
    platform: postgres
    host: remote.example.com
    port: 5432
    database: remotedb`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/orders.sqlx"),
      `config {
  type: "declaration",
  connection: "pg_src",
  name: "orders",
  columnTypes: { id: "bigint" }
}`,
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(result.compile.compiledGraph.operations);
    const srv = operations.find((op) => op.target.name === "pg_src_srv");
    expect(srv, "expected a pg_src_srv bridge operation").to.exist;
    expect(srv.queries).deep.equals([
      'create extension if not exists "postgres_fdw" cascade',
      'drop server if exists "pg_src_srv" cascade',
      `create server "pg_src_srv" foreign data wrapper "postgres_fdw" options (host 'remote.example.com', port '5432', dbname 'remotedb')`,
      // Credentials are non-secret placeholders, injected at run time from
      // .df-credentials.json's `connections` map — never baked into the graph.
      `create user mapping for current_user server "pg_src_srv" options (user '\${SA_CONN:pg_src:user}', password '\${SA_CONN:pg_src:password}')`,
    ]);
  });

  test("foreignTable emits ref-able create foreign table depending on the server", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: supabase`,
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
      `,
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/use_zip.sqlx"),
      `config { type: "view", schema: "bq_ext" }\nSELECT zip_code FROM \${ref("zip_codes")}`,
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
      `create foreign table "bq_ext"."zip_codes" ("zip_code" text, "internal_point_lat" float8, "internal_point_lon" float8) server "bq_server" options (table 'zip_codes', location 'US')`,
    ]);
    const views = asPlainObject(result.compile.compiledGraph.tables);
    const view = views.find((t) => t.target.name === "use_zip");
    expect(view.dependencyTargets.map((t) => t.name)).deep.equals(["zip_codes"]);
  });

  test("wrapper rejects unknown provider", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: supabase`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `wrapper({ name: "x", provider: "snowflake", server: "s" });`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errors = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errors.join("\n")).to.match(/Unknown wrapper provider "snowflake"/);
  });

  test("wrapper without provider requires handler and validator", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: supabase`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/bq.js"),
      `wrapper({ name: "x", wrapper: "some_fdw", server: "s" });`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errors = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errors.join("\n")).to.match(/must also set "handler" and "validator"/);
  });

  test("connection-tagged declaration requires columnTypes", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: d\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "bq", schema: "geo_us_boundaries", name: "zip_codes" });`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errs = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errs.join("\n")).to.match(/requires .?columnTypes/);
  });

  test("declaration on an unknown connection errors", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: d\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "nope", schema: "s", name: "t", columnTypes: { a: "text" } });`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    const errs = result.compile.compiledGraph.graphErrors.compilationErrors.map((e) => e.message);
    expect(errs.join("\n")).to.match(/Unknown connection "nope"/);
  });

  test("declaration on a bigquery connection generates a ref-able FDW bridge", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip.js"),
      `declare({ connection: "bq", name: "zip_codes", columnTypes: { zip_code: "text", lat: "float8" } });`,
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/use.sqlx"),
      `config { type: "view", schema: "public" }\nSELECT zip_code FROM \${ref("zip_codes")}`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const ops = asPlainObject(result.compile.compiledGraph.operations);
    const ft = ops.find((op) => op.target.name === "zip_codes");
    expect(ft).to.exist;
    expect(ft.target.schema).equals("bq_ext");
    expect(ft.hasOutput).equals(true);
    expect(ft.queries[1]).equals(
      `create foreign table "bq_ext"."zip_codes" ("zip_code" text, "lat" float8) server "bq_srv" options (table 'zip_codes')`,
    );
    const server = ops.find((op) => op.target.name === "bq_srv");
    expect(server.queries[0]).equals('create extension if not exists "wrappers" cascade');
    const view = asPlainObject(result.compile.compiledGraph.tables).find(
      (t) => t.target.name === "use",
    );
    expect(view.dependencyTargets.map((t) => t.name)).deep.equals(["zip_codes"]);
  });

  test("declaration on a postgres connection generates a postgres_fdw bridge, server deduped", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres\n    host: db.example.com\n    port: 5432\n    database: legacy\n    defaultSchema: public`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/src.js"),
      `declare({ connection: "legacy", name: "orders", columnTypes: { id: "bigint" } });\n` +
        `declare({ connection: "legacy", name: "customers", columnTypes: { id: "bigint" } });`,
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
      `create server "legacy_srv" foreign data wrapper "postgres_fdw" options (host 'db.example.com', port '5432', dbname 'legacy')`,
      `create user mapping for current_user server "legacy_srv" options (user '\${SA_CONN:legacy:user}', password '\${SA_CONN:legacy:password}')`,
    ]);
    const orders = ops.find((op) => op.target.name === "orders");
    expect(orders.queries[1]).equals(
      `create foreign table "legacy_ext"."orders" ("id" bigint) server "legacy_srv" options (schema_name 'public', table_name 'orders')`,
    );
  });

  test("sqlx declaration with a connection generates the FDW bridge", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: p\ndefaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    // SQLX declaration (NOT the JS API) with a connection + columnTypes:
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip_codes.sqlx"),
      `config {\n  type: "declaration",\n  connection: "bq",\n  name: "zip_codes",\n  columnTypes: { zip_code: "text" }\n}`,
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const ops = asPlainObject(result.compile.compiledGraph.operations);
    const ft = ops.find((op) => op.target.name === "zip_codes");
    expect(ft).to.exist;
    expect(ft.target.schema).equals("bq_ext");
    expect(ft.hasOutput).equals(true);
    const server = ops.find((op) => op.target.name === "bq_srv");
    expect(server).to.exist;
  });

  function supabaseProject(files: { [path: string]: string }) {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: supabase`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/users.js"),
      `publish("users", { type: "table" }).query(ctx => "SELECT 1")`,
    );
    Object.entries(files).forEach(([file, contents]) =>
      fs.writeFileSync(path.join(projectDir, file), contents),
    );
    return runMainInVm(coreExecutionRequestFromPath(projectDir)).compile.compiledGraph;
  }

  [
    {
      call: `rlsPolicy({ table: "users", using: "true" })`,
      error: /RLS policies must have a populated 'name' field/,
    },
    {
      call: `rlsPolicy({ name: "p", using: "true" })`,
      error: /RLS policy "p" must have a populated 'table' field/,
    },
    {
      call: `vectorIndex({ table: "users", column: "embedding" })`,
      error: /Vector indexes must have a populated 'name' field/,
    },
    {
      call: `vectorIndex({ name: "i", column: "embedding" })`,
      error: /Vector index "i" must have a populated 'table' field/,
    },
    {
      call: `vectorIndex({ name: "i", table: "users" })`,
      error: /Vector index "i" must have a populated 'column' field/,
    },
    {
      call: `realtimePublication({ name: "pub" })`,
      error: /Realtime publications must have a populated 'table' field/,
    },
  ].forEach(({ call, error }) => {
    test(`${call} is a compile error`, () => {
      const graph = supabaseProject({ "definitions/supabase.js": call });
      const errors = graph.graphErrors.compilationErrors.map((e) => e.message);
      expect(errors.join("\n")).to.match(error);
      expect(graph.operations.map((op) => op.target.name)).not.to.include.members([
        "users_policy_undefined",
        "users_idx_undefined",
        "undefined_policy_p",
        "undefined_idx_i",
        "undefined_realtime_pub",
      ]);
    });
  });

  test("actions.yaml defines rlsPolicy, realtimePublication and vectorIndex actions", () => {
    const graph = supabaseProject({
      "definitions/setup.js": `operate("seed").queries("SELECT 1")`,
      "definitions/actions.yaml": `
actions:
- rlsPolicy:
    name: select_policy
    table: users
    command: SELECT
    roles: [authenticated]
    using: "true"
    dependencyTargets:
    - name: seed
- realtimePublication:
    table: users
- vectorIndex:
    name: user_embeddings_idx
    table: users
    column: embedding
    indexType: hnsw
    params:
      opclass: vector_cosine_ops
`,
    });

    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(graph.operations);

    const rlsOp = operations.find((op: any) => op.target.name === "users_policy_select_policy");
    expect(rlsOp.fileName).equals("definitions/actions.yaml");
    expect(rlsOp.queries).deep.equals([
      'alter table "defaultProject"."defaultDataset"."users" enable row level security',
      'drop policy if exists "select_policy" on "defaultProject"."defaultDataset"."users"',
      'create policy "select_policy" on "defaultProject"."defaultDataset"."users" for SELECT to authenticated USING (true)',
    ]);
    expect(rlsOp.dependencyTargets.map((t: any) => t.name)).deep.equals(["users", "seed"]);

    const realtimeOp = operations.find(
      (op: any) => op.target.name === "users_realtime_supabase_realtime",
    );
    expect(realtimeOp.queries).deep.equals([
      'alter table "defaultProject"."defaultDataset"."users" replica identity full',
      'alter publication supabase_realtime add table "defaultProject"."defaultDataset"."users"',
    ]);

    const vectorOp = operations.find(
      (op: any) => op.target.name === "users_idx_user_embeddings_idx",
    );
    expect(vectorOp.queries).deep.equals([
      "create extension if not exists vector cascade",
      'drop index if exists "user_embeddings_idx"',
      'create index "user_embeddings_idx" on "defaultProject"."defaultDataset"."users" using hnsw ("embedding" vector_cosine_ops)',
    ]);
  });

  test("actions.yaml foreignWrapper points at wrapper() instead of failing as empty", () => {
    const graph = supabaseProject({
      "definitions/actions.yaml": `
actions:
- foreignWrapper:
    name: bq_wrapper
    server: bq_server
`,
    });
    const errors = graph.graphErrors.compilationErrors;
    expect(errors.map((e) => e.message).join("\n"))
      .to.match(/foreignWrapper actions can't be defined in actions\.yaml/)
      .and.to.match(/wrapper\(\{/)
      .and.not.to.match(/Empty action configs/);
    expect(errors[0].fileName).equals("definitions/actions.yaml");
  });

  test("an invalid actions.yaml Supabase entry is reported without stopping other actions", () => {
    const graph = supabaseProject({
      "definitions/actions.yaml": `
actions:
- rlsPolicy:
    table: users
- vectorIndex:
    name: ok_idx
    table: users
    column: embedding
`,
    });
    const errors = graph.graphErrors.compilationErrors;
    expect(errors.map((e) => e.message).join("\n")).to.match(
      /RLS policies must have a populated 'name' field/,
    );
    expect(errors[0].fileName).equals("definitions/actions.yaml");
    expect(graph.operations.map((op) => op.target.name)).to.include("users_idx_ok_idx");
  });
  suite("table-level supabase block", () => {
    const IndexType = sqlanvil.SupabaseOptions.VectorConfig.IndexType;

    [
      { given: `indexType: "hnsw",`, expected: IndexType.HNSW },
      { given: `indexType: "HNSW",`, expected: IndexType.HNSW },
      { given: `indexType: "ivfflat",`, expected: IndexType.IVFFLAT },
      { given: ``, expected: IndexType.HNSW },
    ].forEach(({ given, expected }) => {
      test(`vectors indexType ${given || "(omitted)"} compiles to ${IndexType[expected]}`, () => {
        ["table", "incremental"].forEach((type) => {
          const graph = supabaseProject({
            "definitions/documents.sqlx": `
config {
  type: "${type}",
  supabase: { vectors: [{ column: "embedding", ${given} params: { m: "16" } }] }
}
SELECT 1 AS id`,
          });
          expect(graph.graphErrors.compilationErrors).deep.equals([]);
          const documents = graph.tables.find((t) => t.target.name === "documents");
          expect(documents.supabase.vectors[0].indexType).equals(expected);
          // The enum must survive the binary encode the runner receives.
          const decoded = sqlanvil.CompiledGraph.decode(
            sqlanvil.CompiledGraph.encode(graph).finish(),
          );
          expect(
            decoded.tables.find((t) => t.target.name === "documents").supabase.vectors[0].indexType,
          ).equals(expected);
        });
      });
    });

    test("an unknown vectors indexType is a compile error", () => {
      const graph = supabaseProject({
        "definitions/documents.sqlx": `
config { type: "table", supabase: { vectors: [{ column: "embedding", indexType: "flat" }] } }
SELECT 1 AS id`,
      });
      expect(graph.graphErrors.compilationErrors.map((e) => e.message).join("\n")).to.match(
        /Unknown vector indexType "flat"; use one of: ivfflat, hnsw\./,
      );
    });

    test("a vector without a column is a compile error", () => {
      const graph = supabaseProject({
        "definitions/documents.sqlx": `
config { type: "table", supabase: { vectors: [{ indexType: "hnsw" }] } }
SELECT 1 AS id`,
      });
      expect(graph.graphErrors.compilationErrors.map((e) => e.message).join("\n")).to.match(
        /Each supabase\.vectors entry needs a 'column'/,
      );
    });

    test("the supabase block on a non-supabase warehouse is a compile error", () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        `defaultProject: defaultProject\ndefaultDataset: defaultDataset\nwarehouse: postgres`,
      );
      fs.mkdirSync(path.join(projectDir, "definitions"));
      fs.writeFileSync(
        path.join(projectDir, "definitions/documents.sqlx"),
        `config { type: "table", supabase: { enableRls: true } }\nSELECT 1 AS id`,
      );
      const graph = runMainInVm(coreExecutionRequestFromPath(projectDir)).compile.compiledGraph;
      expect(graph.graphErrors.compilationErrors.map((e) => e.message).join("\n")).to.match(
        /The supabase: \{\} block requires warehouse: supabase \(this project uses "postgres"\)/,
      );
    });
  });
});
