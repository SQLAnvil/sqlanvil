import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { targetAsReadableString } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { compile, getTableRows, keyBy } from "sa/tests/integration/utils";
import { MysqlFixture } from "sa/tools/mysql/mysql_fixture";

// Runs against whichever engine the MYSQL_* env points at — mysql:8 on 3306 or
// mariadb:11 on 3307 (see tools/mysql/run-mysql-db.sh). The generated SQL is the
// same for both, which is the point.
suite("@sqlanvil/integration/mysql", { parallel: false }, ({ before, after }) => {
  let dbadapter: dbadapters.IDbAdapter;

  const mysql = new MysqlFixture(before, after);

  // MySQL has no catalog level, so each test "schema" is its own database.
  const TEST_DATABASES = [
    "sa_integration_test_project_e2e",
    "sa_integration_test_assertions_project_e2e",
    "sa_integration_test_direct"
  ];

  before("create adapter", async () => {
    dbadapter = await MySqlDbAdapter.create(
      {
        host: MysqlFixture.host,
        port: MysqlFixture.port,
        database: MysqlFixture.database,
        user: MysqlFixture.user,
        password: MysqlFixture.password
      },
      { disableSslForTestsOnly: true }
    );
    // Clear any stale test databases from previous runs.
    for (const database of TEST_DATABASES) {
      try {
        await dbadapter.execute(`drop database if exists \`${database}\``);
      } catch (e) {
        // ignore
      }
    }
  });

  after("cleanup", async () => {
    for (const database of TEST_DATABASES) {
      try {
        await dbadapter.execute(`drop database if exists \`${database}\``);
      } catch (e) {
        // ignore
      }
    }
    await (dbadapter as MySqlDbAdapter).close();
  });

  test("create() fails fast with a clear error on bad credentials", { timeout: 30000 }, async () => {
    let err: Error | undefined;
    try {
      await MySqlDbAdapter.create(
        {
          host: MysqlFixture.host,
          port: MysqlFixture.port,
          database: MysqlFixture.database,
          user: MysqlFixture.user,
          password: "definitely-the-wrong-password"
        },
        { disableSslForTestsOnly: true }
      );
    } catch (e) {
      err = e;
    }
    expect(err, "create() should reject when credentials are bad").to.be.an("error");
    expect(err.message.toLowerCase()).to.match(/could not connect|access denied|authentication/);
  });

  test("a failing statement rejects with the real error", async () => {
    let err: Error | undefined;
    try {
      await dbadapter.execute("selct 1");
    } catch (e) {
      err = e;
    }
    expect(err, "a bad statement should reject").to.be.an("error");
    expect(err.message.toLowerCase()).to.match(/sql syntax|you have an error/);
  });

  test("table and view generate two-part backticked DDL and are queryable", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    const adapter = new ExecutionSql({ warehouse: "mysql" }, "2.0.0");

    const table: sqlanvil.ITable = {
      enumType: sqlanvil.TableType.TABLE,
      target: { schema: database, name: "t" },
      query: "select 1 as id union all select 2 as id"
    };
    for (const task of adapter.publishTasks(table, { fullRefresh: true }).build()) {
      await dbadapter.execute(task.statement);
    }
    const tableRows = await getTableRows(table.target, adapter, dbadapter);
    expect(tableRows.length).to.equal(2);

    const view: sqlanvil.ITable = {
      enumType: sqlanvil.TableType.VIEW,
      target: { schema: database, name: "v" },
      query: `select id from \`${database}\`.\`t\``
    };
    for (const task of adapter.publishTasks(view, { fullRefresh: false }).build()) {
      await dbadapter.execute(task.statement);
    }
    const viewRows = await getTableRows(view.target, adapter, dbadapter);
    expect(viewRows.length).to.equal(2);

    // The adapter introspects the database via information_schema.
    const meta = await dbadapter.table({ schema: database, name: "t" });
    expect(meta).to.not.equal(null);
    expect(meta.type).to.equal(sqlanvil.TableMetadata.Type.TABLE);
    expect(meta.fields.map(f => f.name)).to.include("id");

    const viewMeta = await dbadapter.table({ schema: database, name: "v" });
    expect(viewMeta.type).to.equal(sqlanvil.TableMetadata.Type.VIEW);

    await dbadapter.execute(`drop database if exists \`${database}\``);
  });

  test("run: full project build, incremental append, assertion pass/fail", { timeout: 120000 }, async () => {
    const compiledGraph = await compile("tests/integration/mysql_project", "project_e2e");

    // Run the whole project.
    let executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    let executedGraph = await dfapi.run(dbadapter, executionGraph).result();

    const actionMap = keyBy(executedGraph.actions, v => targetAsReadableString(v.target));
    expect(Object.keys(actionMap).length).to.equal(8);

    const expectedFailedActions = [
      "sa_integration_test_assertions_project_e2e.example_assertion_fail"
    ];
    for (const actionName of Object.keys(actionMap)) {
      const expectedResult = expectedFailedActions.includes(actionName)
        ? sqlanvil.ActionResult.ExecutionStatus.FAILED
        : sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL;
      expect(actionMap[actionName].status).to.equal(
        expectedResult,
        `${actionName}: ${actionMap[actionName].tasks.map(t => t.errorMessage).join("\n")}`
      );
    }

    // The failing assertion reports through the mysql error prefix.
    expect(
      actionMap["sa_integration_test_assertions_project_e2e.example_assertion_fail"].tasks.slice(-1)[0]
        .errorMessage
    ).to.equal("mysql error: Assertion failed: query returned 1 row(s).");

    const adapter = new ExecutionSql(compiledGraph.projectConfig, compiledGraph.sqlanvilCoreVersion);

    // Incremental (no uniqueKey): 3 rows on first build.
    let incremental = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental"
    ];
    expect((await getTableRows(incremental.target, adapter, dbadapter)).length).to.equal(3);

    // Incremental merge (uniqueKey): 2 rows on first build.
    let merge = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental_merge"
    ];
    expect((await getTableRows(merge.target, adapter, dbadapter)).length).to.equal(2);

    // Re-run the tables: incremental appends, merge upserts (no new rows).
    executionGraph = await dfapi.build(
      compiledGraph,
      { actions: ["example_incremental", "example_incremental_merge", "example_table", "example_view"] },
      dbadapter
    );
    executedGraph = await dfapi.run(dbadapter, executionGraph).result();
    expect(executedGraph.status).to.equal(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      executedGraph.actions
        .map(action => action.tasks.map(task => task.errorMessage).join("\n"))
        .join("\n")
    );

    // Append added 2 rows (user_timestamp > MIN) -> 5 total.
    incremental = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental"
    ];
    expect((await getTableRows(incremental.target, adapter, dbadapter)).length).to.equal(5);

    // Merge upserted the same two keys -> still 2 rows, values updated to 'new'.
    merge = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental_merge"
    ];
    const mergeRows = await getTableRows(merge.target, adapter, dbadapter);
    expect(mergeRows.length).to.equal(2);
    expect(mergeRows.every((r: any) => r.val === "new")).to.equal(true);
  });

  test("evaluate validates good and bad queries via EXPLAIN", { timeout: 30000 }, async () => {
    const good = await dbadapter.evaluate(
      sqlanvil.Table.create({
        enumType: sqlanvil.TableType.TABLE,
        query: "select 1 as id",
        target: { schema: "sa_integration_test_direct", name: "ev_ok" }
      })
    );
    expect(good[0].status).to.equal(sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS);

    const bad = await dbadapter.evaluate(
      sqlanvil.Table.create({
        enumType: sqlanvil.TableType.TABLE,
        query: "thisisillegal",
        target: { schema: "sa_integration_test_direct", name: "ev_bad" }
      })
    );
    expect(bad[0].status).to.equal(sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE);
  });
});
