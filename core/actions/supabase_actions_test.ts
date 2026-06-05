import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { asPlainObject, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import {
  coreExecutionRequestFromPath,
  runMainInVm,
  VALID_WORKFLOW_SETTINGS_YAML
} from "sa/testing/run_core";

suite("supabase actions", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("compiling supabase custom actions", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: defaultProject
defaultDataset: defaultDataset
warehouse: postgres`
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));

    // Write a table definitions file
    fs.writeFileSync(
      path.join(projectDir, "definitions/users.js"),
      `publish("users", { type: "table" }).query(ctx => "SELECT 1")`
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
      `
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
      'create policy "select_policy" on "defaultProject"."defaultDataset"."users" for SELECT to authenticated USING (true)'
    ]);

    // Verify Realtime publication operation exists and generated correct queries
    const realtimeOp = operations.find((op: any) => op.target.name === "users_realtime_supabase_realtime");
    expect(realtimeOp).to.exist;
    expect(realtimeOp.queries).deep.equals([
      'alter table "defaultProject"."defaultDataset"."users" replica identity full',
      'alter publication supabase_realtime add table "defaultProject"."defaultDataset"."users"'
    ]);

    // Verify FDW Wrapper operation exists and generated correct queries
    const wrapperOp = operations.find((op: any) => op.target.name === "bq_wrapper");
    expect(wrapperOp).to.exist;
    expect(wrapperOp.queries).deep.equals([
      'create extension if not exists "wrappers" cascade',
      `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 'bigquery_wrapper') then create foreign data wrapper bigquery_wrapper handler big_query_fdw_handler validator big_query_fdw_validator; end if; end $$`,
      'drop server if exists "bq_server" cascade',
      `create server "bq_server" foreign data wrapper "bigquery_wrapper" options (project_id 'my-gcp-project')`
    ]);

    // Verify Vector index operation exists and generated correct queries
    const vectorOp = operations.find((op: any) => op.target.name === "users_idx_user_embeddings_idx");
    expect(vectorOp).to.exist;
    expect(vectorOp.queries).deep.equals([
      'create extension if not exists vector cascade',
      'drop index if exists "user_embeddings_idx"',
      'create index "user_embeddings_idx" on "defaultProject"."defaultDataset"."users" using hnsw ("embedding" vector_cosine_ops) with (m = 16)'
    ]);
  });

  test("wrapper still accepts the legacy options field for server options", () => {
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
        name: "bq_legacy",
        provider: "bigquery",
        server: "bq_legacy_server",
        options: { project_id: "my-gcp-project" }
      });
      `
    );
    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));
    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    const operations = asPlainObject(result.compile.compiledGraph.operations);
    const setup = operations.find((op) => op.target.name === "bq_legacy");
    expect(setup).to.exist;
    expect(setup.queries[3]).equals(
      `create server "bq_legacy_server" foreign data wrapper "bigquery_wrapper" options (project_id 'my-gcp-project')`
    );
  });

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
});
