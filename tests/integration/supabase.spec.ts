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
        password: SupabaseFixture.password
      },
      { disableSslForTestsOnly: true }
    );
    // Clear any stale test schemas from previous runs
    for (const schema of [
      "df_integration_test",
      "df_integration_test_assertions"
    ]) {
      try {
        await dbadapter.execute(`drop schema if exists "${schema}" cascade`);
      } catch (e) {
        // ignore
      }
    }

    // Pre-create standard Supabase role if it doesn't exist (useful for testing on standard Postgres)
    try {
      await dbadapter.execute("create role authenticated");
    } catch (e) {
      // ignore if already exists
    }
  });

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

    const actionMap = keyBy(executedGraph.actions, v => targetAsReadableString(v.target));
    
    // Check that our custom actions compiled down and were executed successfully!
    expect(executedGraph.status).equals(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      executedGraph.actions
        .map(action => action.tasks.map(task => task.errorMessage).filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n")
    );

    expect(actionMap["df_integration_test.users"]).to.exist;
    expect(actionMap["df_integration_test.users"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL
    );

    // Verify RLS Policy action executed successfully!
    expect(actionMap["df_integration_test.users_policy_select_policy"]).to.exist;
    expect(actionMap["df_integration_test.users_policy_select_policy"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL
    );

    // Verify Realtime Publication action executed successfully!
    expect(actionMap["df_integration_test.users_realtime_supabase_realtime"]).to.exist;
    expect(actionMap["df_integration_test.users_realtime_supabase_realtime"].status).equals(
      sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL
    );
  });
});
