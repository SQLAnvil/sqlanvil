import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { targetAsReadableString } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { compile, getTableRows, keyBy } from "sa/tests/integration/utils";
import { PostgresFixture } from "sa/tools/postgres/postgres_fixture";

suite("@sqlanvil/integration/postgres", { parallel: true }, ({ before, after }) => {
  let dbadapter: dbadapters.IDbAdapter;

  const postgres = new PostgresFixture(5432, before, after);

  before("create adapter", async () => {
    dbadapter = await PostgresDbAdapter.create(
      {
        host: PostgresFixture.host,
        port: PostgresFixture.port,
        database: PostgresFixture.database,
        user: PostgresFixture.user,
        password: PostgresFixture.password
      },
      { disableSslForTestsOnly: true }
    );
    // Clear any stale test schemas from previous runs
    for (const schema of [
      "sa_integration_test_project_e2e",
      "sa_integration_test_dataset_metadata",
      "sa_integration_test_evaluate",
      "sa_integration_test_assertions_project_e2e",
      "sa_integration_test_assertions_evaluate",
      "sa_integration_test_search"
    ]) {
      try {
        await dbadapter.execute(`drop schema if exists "${schema}" cascade`);
      } catch (e) {
        // ignore
      }
    }
  });

  test("run", { timeout: 60000 }, async () => {
    const compiledGraph = await compile("tests/integration/postgres_project", "project_e2e");

    // Run the project.
    let executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    let executedGraph = await dfapi.run(dbadapter, executionGraph).result();

    const actionMap = keyBy(executedGraph.actions, v => targetAsReadableString(v.target));
    expect(Object.keys(actionMap).length).eql(11);

    // Check the status of action execution.
    const expectedFailedActions = [
      "sa_integration_test_assertions_project_e2e.example_assertion_fail"
    ];
    for (const actionName of Object.keys(actionMap)) {
      const expectedResult = expectedFailedActions.includes(actionName)
        ? sqlanvil.ActionResult.ExecutionStatus.FAILED
        : sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL;
      expect(actionMap[actionName].status).equals(
        expectedResult,
        actionMap[actionName].tasks.map(task => task.errorMessage).join("\n")
      );
    }

    expect(
      actionMap["sa_integration_test_assertions_project_e2e.example_assertion_fail"].tasks[2]
        .errorMessage
    ).to.eql("postgres error: Assertion failed: query returned 1 row(s).");

    // Check the data in the incremental table.
    const adapter = new ExecutionSql(compiledGraph.projectConfig, compiledGraph.sqlanvilCoreVersion);
    let incrementalTable = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental"
    ];
    let incrementalRows = await getTableRows(incrementalTable.target, adapter, dbadapter);
    expect(incrementalRows.length).equals(3);

    // Check the data in the incremental merge table.
    incrementalTable = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental_merge"
    ];
    incrementalRows = await getTableRows(incrementalTable.target, adapter, dbadapter);
    expect(incrementalRows.length).equals(2);

    // Re-run some of the actions.
    executionGraph = await dfapi.build(
      compiledGraph,
      {
        actions: [
          "example_incremental",
          "example_incremental_merge",
          "example_table",
          "example_view"
        ]
      },
      dbadapter
    );
    executedGraph = await dfapi.run(dbadapter, executionGraph).result();
    expect(executedGraph.status).equals(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      executedGraph.actions
        .map(action => action.tasks.map(task => task.errorMessage).join("\n"))
        .join("\n")
    );

    // Check there are the expected number of extra rows in the incremental table.
    incrementalTable = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental"
    ];
    incrementalRows = await getTableRows(incrementalTable.target, adapter, dbadapter);
    expect(incrementalRows.length).equals(5);

    // Check there are the expected number of extra rows in the incremental merge table.
    incrementalTable = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
      "sa_integration_test_project_e2e.example_incremental_merge"
    ];
    incrementalRows = await getTableRows(incrementalTable.target, adapter, dbadapter);
    expect(incrementalRows.length).equals(2);
  });

  test("dataset metadata set correctly", { timeout: 60000 }, async () => {
    const compiledGraph = await compile("tests/integration/postgres_project", "dataset_metadata");

    // Run the project.
    const executionGraph = await dfapi.build(
      compiledGraph,
      {
        actions: ["example_incremental", "example_view"],
        includeDependencies: true
      },
      dbadapter
    );
    const runResult = await dfapi.run(dbadapter, executionGraph).result();
    expect(sqlanvil.RunResult.ExecutionStatus[runResult.status]).eql(
      sqlanvil.RunResult.ExecutionStatus[sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL]
    );

    // Check expected metadata.
    for (const expectedMetadata of [
      {
        target: {
          schema: "sa_integration_test_dataset_metadata",
          name: "example_incremental"
        },
        expectedDescription: "An incremental 'table'",
        expectedFields: [
          sqlanvil.Field.create({
            description: "the 'timestamp'",
            name: "user_timestamp",
            primitive: sqlanvil.Field.Primitive.INTEGER
          }),
          sqlanvil.Field.create({
            description: "the id",
            name: "user_id",
            primitive: sqlanvil.Field.Primitive.INTEGER
          })
        ]
      },
      {
        target: {
          schema: "sa_integration_test_dataset_metadata",
          name: "example_view"
        },
        expectedDescription: "An example view",
        expectedFields: [
          sqlanvil.Field.create({
            name: "val",
            description: "val doc",
            primitive: sqlanvil.Field.Primitive.INTEGER
          })
        ]
      }
    ]) {
      const metadata = await dbadapter.table(expectedMetadata.target);
      expect(metadata.description).to.equal(expectedMetadata.expectedDescription);
      expect(metadata.fields).to.deep.equal(expectedMetadata.expectedFields);
    }
  });

  test("run unit tests", async () => {
    const compiledGraph = await compile("tests/integration/postgres_project", "unit_tests");

    // Run the tests.
    const testResults = await dfapi.test(dbadapter, compiledGraph.tests);
    expect(testResults).to.eql([
      { name: "successful", successful: true },
      {
        name: "expected more rows than got",
        successful: false,
        messages: ["Expected 3 rows, but saw 2 rows."]
      },
      {
        name: "expected fewer columns than got",
        successful: false,
        messages: ['Expected columns "col1,col2,col3", but saw "col1,col2,col3,col4".']
      },
      {
        name: "wrong columns",
        successful: false,
        messages: ['Expected columns "col1,col2,col3,col4", but saw "col1,col2,col3,col5".']
      },
      {
        name: "wrong row contents",
        successful: false,
        messages: [
          'For row 0 and column "col2": expected "1", but saw "5".',
          'For row 1 and column "col3": expected "6.5", but saw "12".',
          'For row 2 and column "col1": expected "sup?", but saw "WRONG".'
        ]
      }
    ]);
  });

  suite("query limits work", { parallel: true }, async () => {
    const query = `
        select 1 union all
        select 2 union all
        select 3 union all
        select 4 union all
        select 5`;

    for (const options of [
      { interactive: true, rowLimit: 2 },
      { interactive: false, rowLimit: 2 },
      { interactive: true, byteLimit: 50 },
      { interactive: false, byteLimit: 50 }
    ]) {
      test(`with options=${JSON.stringify(options)}`, async () => {
        const { rows } = await dbadapter.execute(query, options);
        expect(rows).to.eql([
          {
            "?column?": 1
          },
          {
            "?column?": 2
          }
        ]);
      });
    }
  });

  suite("evaluate", () => {
    test("evaluate from valid compiled graph as valid", async () => {
      const compiledGraph = await compile("tests/integration/postgres_project", "evaluate");
      const executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
      await dfapi.run(dbadapter, executionGraph).result();

      const view = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
        "sa_integration_test_evaluate.example_view"
      ];
      let evaluations = await dbadapter.evaluate(sqlanvil.Table.create(view));
      expect(evaluations.length).to.equal(1);
      expect(evaluations[0].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      );

      const table = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
        "sa_integration_test_evaluate.example_table"
      ];
      evaluations = await dbadapter.evaluate(sqlanvil.Table.create(table));
      expect(evaluations.length).to.equal(1);
      expect(evaluations[0].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      );

      const assertion = keyBy(compiledGraph.assertions, t => targetAsReadableString(t.target))[
        "sa_integration_test_assertions_evaluate.example_assertion_pass"
      ];
      evaluations = await dbadapter.evaluate(sqlanvil.Assertion.create(assertion));
      expect(evaluations.length).to.equal(1);
      expect(evaluations[0].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      );

      const incremental = keyBy(compiledGraph.tables, t => targetAsReadableString(t.target))[
        "sa_integration_test_evaluate.example_incremental"
      ];
      evaluations = await dbadapter.evaluate(sqlanvil.Table.create(incremental));
      expect(evaluations.length).to.equal(2);
      expect(evaluations[0].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      );
      expect(evaluations[1].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      );
    });

    test("invalid table fails validation", async () => {
      const evaluations = await dbadapter.evaluate(
        sqlanvil.Table.create({
          enumType: sqlanvil.TableType.TABLE,
          query: "thisisillegal",
          target: {
            schema: "sa_integration_test",
            name: "example_illegal_table",
            database: "sqlanvil-integration-tests"
          }
        })
      );
      expect(evaluations.length).to.equal(1);
      expect(evaluations[0].status).to.equal(
        sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE
      );
    });
  });

  suite("publish tasks", async () => {
    test("incremental pre and post ops, core version <= 1.4.8", async () => {
      // 1.4.8 used `preOps` and `postOps` instead of `incrementalPreOps` and `incrementalPostOps`.
      const table: sqlanvil.ITable = {
        enumType: sqlanvil.TableType.INCREMENTAL,
        query: "query",
        preOps: ["preop task1", "preop task2"],
        incrementalQuery: "",
        postOps: ["postop task1", "postop task2"],
        target: { schema: "", name: "", database: "" }
      };

      const adapter = new ExecutionSql({ warehouse: "postgres" }, "1.4.8");

      const refresh = adapter.publishTasks(table, { fullRefresh: true }, { fields: [] }).build();

      expect(refresh[0].statement).to.equal(table.preOps[0]);
      expect(refresh[1].statement).to.equal(table.preOps[1]);
      expect(refresh[refresh.length - 2].statement).to.equal(table.postOps[0]);
      expect(refresh[refresh.length - 1].statement).to.equal(table.postOps[1]);

      const increment = adapter.publishTasks(table, { fullRefresh: false }, { fields: [] }).build();

      expect(increment[0].statement).to.equal(table.preOps[0]);
      expect(increment[1].statement).to.equal(table.preOps[1]);
      expect(increment[increment.length - 2].statement).to.equal(table.postOps[0]);
      expect(increment[increment.length - 1].statement).to.equal(table.postOps[1]);
    });
  });

  test("search", async () => {
    const compiledGraph = await compile("tests/integration/postgres_project", "search");

    // Run the project.
    const executionGraph = await dfapi.build(
      compiledGraph,
      {
        actions: ["example_view"],
        includeDependencies: true
      },
      dbadapter
    );
    const runResult = await dfapi.run(dbadapter, executionGraph).result();
    expect(sqlanvil.RunResult.ExecutionStatus[runResult.status]).eql(
      sqlanvil.RunResult.ExecutionStatus[sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL]
    );

    const [fullSearch, partialSearch, columnSearch] = await Promise.all([
      dbadapter.search("sa_integration_test_search"),
      dbadapter.search("test_sear"),
      dbadapter.search("val")
    ]);

    expect(fullSearch.length).equals(2);
    expect(partialSearch.length).equals(2);
    expect(columnSearch.length).greaterThan(0);
  });

  test("postgres storage options + indexes apply on real Postgres", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_options";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);

    const table: sqlanvil.ITable = {
      type: "table",
      enumType: sqlanvil.TableType.TABLE,
      target: { schema, name: "indexed_table" },
      query: "select 1 as id, 'a'::text as label",
      postgres: {
        unlogged: true,
        fillfactor: 70,
        indexes: [
          {
            name: "ix_indexed_table_id",
            columns: ["id"],
            method: sqlanvil.PostgresOptions.Index.Method.BTREE
          },
          {
            name: "ix_indexed_table_label",
            columns: ["label"],
            method: sqlanvil.PostgresOptions.Index.Method.BTREE,
            unique: true,
            where: "label is not null"
          }
        ]
      }
    };

    // Generate the DDL exactly as a real run does, then execute it.
    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");
    for (const task of adapter.publishTasks(table, { fullRefresh: true }, { fields: [] }).build()) {
      await dbadapter.execute(task.statement);
    }

    // Storage options actually applied: UNLOGGED (relpersistence 'u') + fillfactor=70.
    const meta = await dbadapter.execute(
      `select c.relpersistence, c.reloptions from pg_class c ` +
        `join pg_namespace n on n.oid = c.relnamespace ` +
        `where n.nspname = '${schema}' and c.relname = 'indexed_table'`
    );
    expect(meta.rows[0].relpersistence).to.equal("u");
    expect(meta.rows[0].reloptions).to.deep.equal(["fillfactor=70"]);

    // Both indexes created, with unique + partial predicate honored by Postgres.
    const idx = await dbadapter.execute(
      `select indexname, indexdef from pg_indexes where schemaname = '${schema}'`
    );
    const byName = keyBy(idx.rows, (r: { indexname: string }) => r.indexname);
    expect(byName["ix_indexed_table_id"], "btree index should exist").to.exist;
    expect(byName["ix_indexed_table_label"].indexdef).to.contain("UNIQUE");
    expect(byName["ix_indexed_table_label"].indexdef).to.contain("WHERE (label IS NOT NULL)");

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("materialized view is created as a populated matview on real Postgres", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_mv";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);

    const mv: sqlanvil.ITable = {
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      target: { schema, name: "mv_orders" },
      query: "select 1 as id, 100 as amount union all select 2 as id, 200 as amount"
    };

    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");
    for (const task of adapter.publishTasks(mv, { fullRefresh: true }, { fields: [] }).build()) {
      await dbadapter.execute(task.statement);
    }

    // It's a real materialized view (in pg_matviews, not pg_views).
    const matviews = await dbadapter.execute(
      `select matviewname from pg_matviews where schemaname = '${schema}'`
    );
    expect(matviews.rows.map((r: { matviewname: string }) => r.matviewname)).to.include("mv_orders");

    // WITH DATA by default -> populated and queryable.
    const counted = await dbadapter.execute(`select count(*)::int as n from "${schema}"."mv_orders"`);
    expect(counted.rows[0].n).to.equal(2);

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("index operator class applies on real Postgres", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_opclass";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);

    const table: sqlanvil.ITable = {
      type: "table",
      enumType: sqlanvil.TableType.TABLE,
      target: { schema, name: "docs" },
      query: `select 1 as id, '{"a":1}'::jsonb as payload`,
      postgres: {
        indexes: [
          {
            name: "ix_docs_payload",
            columns: ["payload"],
            // gin on jsonb requires an opclass; jsonb_path_ops is built-in (no extension).
            method: sqlanvil.PostgresOptions.Index.Method.GIN,
            opclass: "jsonb_path_ops"
          }
        ]
      }
    };

    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");
    for (const task of adapter.publishTasks(table, { fullRefresh: true }, { fields: [] }).build()) {
      await dbadapter.execute(task.statement);
    }

    const idx = await dbadapter.execute(
      `select indexdef from pg_indexes where schemaname = '${schema}' and indexname = 'ix_docs_payload'`
    );
    expect(idx.rows.length).to.equal(1);
    expect(idx.rows[0].indexdef).to.contain("jsonb_path_ops");

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });
});
