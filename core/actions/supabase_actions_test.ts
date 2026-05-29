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
        wrapper: "bigquery_fdw",
        server: "bq_server",
        options: {
          project_id: "my-gcp-project"
        }
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
      'create extension if not exists "bigquery_fdw" cascade',
      'drop server if exists "bq_server" cascade',
      'create server "bq_server" foreign data wrapper "bigquery_fdw" options (project_id \'my-gcp-project\')'
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
});
