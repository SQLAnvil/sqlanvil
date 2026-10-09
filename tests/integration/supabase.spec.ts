import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { targetAsReadableString } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { compile, keyBy } from "sa/tests/integration/utils";
import { SupabaseFixture } from "sa/tools/supabase/supabase_fixture";

suite("@sqlanvil/integration/supabase", { parallel: true }, ({ before, after }) => {
  let dbadapter: dbadapters.IDbAdapter;

  const supabase = new SupabaseFixture(5433, before, after);

  before("create adapter", async () => {
    dbadapter = await SupabaseDbAdapter.create(
      {
        host: SupabaseFixture.host,
        port: SupabaseFixture.port,
        database: SupabaseFixture.database,
        user: SupabaseFixture.user,
        password: SupabaseFixture.password,
      },
      { disableSslForTestsOnly: true },
    );
    // Clear any stale test schemas from previous runs
    for (const schema of ["sa_integration_test", "sa_integration_test_assertions"]) {
      try {
        await dbadapter.execute(`drop schema if exists "${schema}" cascade`);
      } catch (e) {
        // ignore
      }
    }

    // Pre-create standard Supabase roles if they don't exist (useful for testing on standard Postgres)
    for (const role of ["authenticated", "service_role"]) {
      try {
        await dbadapter.execute(`create role ${role}`);
      } catch (e) {
        // ignore if already exists
      }
    }
    // A table with a vector column needs the type before its CREATE TABLE AS runs.
    await dbadapter.execute("create extension if not exists vector");
  });

  test(
    "create() fails fast with a clear error on bad credentials",
    { timeout: 30000 },
    async () => {
      let err: Error | undefined;
      try {
        await SupabaseDbAdapter.create(
          {
            host: SupabaseFixture.host,
            port: SupabaseFixture.port,
            database: SupabaseFixture.database,
            user: SupabaseFixture.user,
            password: "definitely-the-wrong-password",
          },
          { disableSslForTestsOnly: true },
        );
      } catch (e) {
        err = e;
      }
      expect(err, "create() should reject when credentials are bad").to.be.an("error");
      expect(err.message.toLowerCase()).to.match(
        /password authentication failed|could not connect|authentication/,
      );
    },
  );

  test("run supabase native actions", { timeout: 60000 }, async () => {
    // 1. Compile the Supabase integration project
    const compiledGraph = await compile("tests/integration/supabase_project", "");

    // 2. Pre-create the publication so ALTER PUBLICATION won't fail (unless it already exists)
    try {
      await dbadapter.execute("create publication supabase_realtime");
    } catch (e) {
      // ignore if already exists
    }

    // 3. Build and execute the graph
    const executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    const executedGraph = await dfapi.run(dbadapter, executionGraph).result();

    const actionMap = keyBy(executedGraph.actions, (v) => targetAsReadableString(v.target));

    // Check that our custom actions compiled down and were executed successfully!
    expect(executedGraph.status).equals(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      executedGraph.actions
        .map((action) =>
          action.tasks
            .map((task) => task.errorMessage)
            .filter(Boolean)
            .join("\n"),
        )
        .filter(Boolean)
        .join("\n"),
    );

    expect(actionMap["sa_integration_test.users"]).to.exist;
    expect(actionMap["sa_integration_test.users"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
    );

    // Verify RLS Policy action executed successfully!
    expect(actionMap["sa_integration_test.users_policy_select_policy"]).to.exist;
    expect(actionMap["sa_integration_test.users_policy_select_policy"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
    );

    // Verify Realtime Publication action executed successfully!
    expect(actionMap["sa_integration_test.users_realtime_supabase_realtime"]).to.exist;
    expect(actionMap["sa_integration_test.users_realtime_supabase_realtime"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
    );

    // The table-level supabase: {} block was applied to the tables that use it.
    const expectSupabaseBlockApplied = async () => {
      const documents = (
        await dbadapter.execute(
          `select c.relrowsecurity, c.relreplident, pg_get_userbyid(c.relowner) as owner
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'sa_integration_test' and c.relname = 'documents'`,
        )
      ).rows[0];
      expect(documents).deep.equals({
        relrowsecurity: true,
        relreplident: "f",
        owner: "service_role",
      });

      const indexes = (
        await dbadapter.execute(
          `select indexname, indexdef from pg_indexes
           where schemaname = 'sa_integration_test' and tablename = 'documents' order by indexname`,
        )
      ).rows.map((row: any) => [row.indexname, row.indexdef.replace(/^.* USING /, "USING ")]);
      expect(indexes).deep.equals([
        ["documents_embedding_idx", "USING hnsw (embedding vector_cosine_ops) WITH (m='16')"],
        ["documents_id_idx", "USING btree (id)"],
      ]);

      const published = (
        await dbadapter.execute(
          `select tablename from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'sa_integration_test' order by tablename`,
        )
      ).rows.map((row: any) => row.tablename);
      expect(published).to.include.members(["documents", "events"]);

      const events = (
        await dbadapter.execute(
          `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'sa_integration_test' and c.relname = 'events'`,
        )
      ).rows[0];
      expect(events.relrowsecurity).equals(true);
    };
    await expectSupabaseBlockApplied();

    // A second run rebuilds `documents` (re-applying the block) and appends to `events`
    // (which must not re-run it: adding a table to a publication twice errors).
    const rerun = await dfapi
      .run(dbadapter, await dfapi.build(compiledGraph, {}, dbadapter))
      .result();
    expect(rerun.status).equals(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      rerun.actions
        .map((action) =>
          action.tasks
            .map((task) => task.errorMessage)
            .filter(Boolean)
            .join("\n"),
        )
        .filter(Boolean)
        .join("\n"),
    );
    await expectSupabaseBlockApplied();
  });
});
