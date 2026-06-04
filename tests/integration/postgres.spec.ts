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

  test("native range-partitioned table builds and routes rows on real Postgres", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_part";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);

    const table: sqlanvil.ITable = {
      type: "table",
      enumType: sqlanvil.TableType.TABLE,
      target: { schema, name: "events" },
      query: "select 5 as id, 'low' as label union all select 150 as id, 'high' as label",
      postgres: {
        partition: {
          kind: sqlanvil.PostgresOptions.Partition.Kind.RANGE,
          columns: ["id"],
          partitions: [
            { name: "p_lo", values: "FROM (0) TO (100)" },
            { name: "p_hi", values: "FROM (100) TO (1000)" }
          ],
          includeDefault: true
        }
      }
    };

    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");
    for (const task of adapter.publishTasks(table, { fullRefresh: true }, { fields: [] }).build()) {
      await dbadapter.execute(task.statement);
    }

    // Parent is a partitioned table (relkind 'p').
    const parent = await dbadapter.execute(
      `select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
        `where n.nspname = '${schema}' and c.relname = 'events'`
    );
    expect(parent.rows[0].relkind).to.equal("p");

    // Rows inserted and routed to the right child: id=5 -> p_lo [0,100), id=150 -> p_hi [100,1000).
    const total = await dbadapter.execute(`select count(*)::int as n from "${schema}"."events"`);
    expect(total.rows[0].n).to.equal(2);
    const lo = await dbadapter.execute(`select count(*)::int as n from "${schema}"."events__p_lo"`);
    expect(lo.rows[0].n).to.equal(1);
    const hi = await dbadapter.execute(`select count(*)::int as n from "${schema}"."events__p_hi"`);
    expect(hi.rows[0].n).to.equal(1);

    // Staging table was cleaned up.
    const stage = await dbadapter.execute(
      `select count(*)::int as n from information_schema.tables ` +
        `where table_schema = '${schema}' and table_name = 'events__sa_stage'`
    );
    expect(stage.rows[0].n).to.equal(0);

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("matview: adapter detects it and refreshes in place on rerun", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_mvref";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);
    await dbadapter.execute(`create table "${schema}"."src" (id int)`);
    await dbadapter.execute(`insert into "${schema}"."src" values (1), (2)`);

    const mv: sqlanvil.ITable = {
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      target: { schema, name: "mv" },
      query: `select count(*)::int as n from "${schema}"."src"`,
      postgres: { refreshPolicy: "on_dependency_change" }
    };
    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");

    // First run: matview doesn't exist -> created.
    for (const t of adapter.publishTasks(mv, { fullRefresh: false }).build()) {
      await dbadapter.execute(t.statement);
    }

    // The adapter now DETECTS the matview (information_schema would miss it).
    const meta = await dbadapter.table({ schema, name: "mv" });
    expect(meta, "adapter should find the matview").to.not.equal(null);
    expect(meta.type).to.equal(sqlanvil.TableMetadata.Type.MATERIALIZED_VIEW);
    expect(meta.fields.map(f => f.name)).to.include("n");
    const listed = await dbadapter.tables("", schema);
    expect(listed.some(t => t.target.name === "mv")).to.equal(true);

    const oidOf = async () =>
      (
        await dbadapter.execute(
          `select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
            `where n.nspname = '${schema}' and c.relname = 'mv'`
        )
      ).rows[0].oid;
    const oidBefore = await oidOf();

    // Add a row, then RE-RUN with the detected metadata: it should REFRESH in place.
    await dbadapter.execute(`insert into "${schema}"."src" values (3)`);
    const rerun = adapter.publishTasks(mv, { fullRefresh: false }, meta).build().map(t => t.statement);
    expect(rerun).to.eql([`refresh materialized view "${schema}"."mv"`]);
    for (const stmt of rerun) {
      await dbadapter.execute(stmt);
    }

    // Same object (not dropped+recreated), and the data reflects the new row.
    expect(await oidOf(), "matview should be refreshed, not recreated").to.equal(oidBefore);
    const val = await dbadapter.execute(`select n from "${schema}"."mv"`);
    expect(val.rows[0].n).to.equal(3);

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("matview WITH NO DATA is created unpopulated", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_mvnodata";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);

    const mv: sqlanvil.ITable = {
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      target: { schema, name: "mv" },
      query: "select 1 as id",
      postgres: { noData: true }
    };
    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");
    for (const t of adapter.publishTasks(mv, { fullRefresh: false }).build()) {
      await dbadapter.execute(t.statement);
    }

    const pop = await dbadapter.execute(
      `select c.relispopulated from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
        `where n.nspname = '${schema}' and c.relname = 'mv'`
    );
    expect(pop.rows[0].relispopulated).to.equal(false);

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("operations run a stored PROCEDURE with a $$ body on Postgres", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_ops";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);
    await dbadapter.execute(`create table "${schema}"."log" (n int)`);

    const adapter = new ExecutionSql({ warehouse: "postgres" }, "2.0.0");

    // A PROCEDURE whose $$-quoted body contains internal semicolons (a loop) —
    // the case that would break naive ;-based statement splitting. sqlx splits
    // operations on `---`, so the whole body stays one statement.
    const createProc: sqlanvil.IOperation = {
      target: { schema, name: "create_proc" },
      queries: [
        `create procedure "${schema}"."seed"(cnt int) language plpgsql as $$
begin
  for i in 1..cnt loop
    insert into "${schema}"."log" values (i);
  end loop;
end;
$$`
      ]
    };
    const callProc: sqlanvil.IOperation = {
      target: { schema, name: "call_proc" },
      queries: [`call "${schema}"."seed"(3)`]
    };

    for (const op of [createProc, callProc]) {
      for (const task of adapter.createOperationTasks(op)) {
        await dbadapter.execute(task.statement);
      }
    }

    // The procedure was created, CALLed, and its side effect happened.
    const res = await dbadapter.execute(`select count(*)::int as n from "${schema}"."log"`);
    expect(res.rows[0].n).to.equal(3);

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("metadata: table description + column comments applied and read back", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_meta";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);
    await dbadapter.execute(`create table "${schema}"."t" (id int, label text)`);

    await dbadapter.setMetadata({
      target: { schema, name: "t" },
      tableType: "table",
      actionDescriptor: {
        description: "a table's \"desc\" with 'quotes'",
        columns: [
          { path: ["id"], description: "the id" },
          { path: ["label"], description: "the label" }
        ]
      }
    });

    const meta = await dbadapter.table({ schema, name: "t" });
    expect(meta.description).to.equal("a table's \"desc\" with 'quotes'");
    const byName = keyBy(meta.fields, f => f.name);
    expect(byName["id"].description).to.equal("the id");
    expect(byName["label"].description).to.equal("the label");

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("metadata: materialized view description + column comments applied and read back", { timeout: 60000 }, async () => {
    const schema = "sa_integration_test_metamv";
    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await dbadapter.execute(`create schema "${schema}"`);
    await dbadapter.execute(`create materialized view "${schema}"."mv" as select 1 as id, 'a'::text as label`);

    // A matview action carries tableType "view"; setMetadata must use
    // COMMENT ON MATERIALIZED VIEW (not COMMENT ON VIEW, which errors).
    await dbadapter.setMetadata({
      target: { schema, name: "mv" },
      tableType: "view",
      actionDescriptor: {
        description: "an example matview",
        columns: [{ path: ["id"], description: "the id" }]
      }
    });

    const meta = await dbadapter.table({ schema, name: "mv" });
    expect(meta.type).to.equal(sqlanvil.TableMetadata.Type.MATERIALIZED_VIEW);
    expect(meta.description).to.equal("an example matview");
    expect(keyBy(meta.fields, f => f.name)["id"].description).to.equal("the id");

    await dbadapter.execute(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
  });

  test("auto-generated uniqueKey assertions detect duplicates on Postgres (single/multi/multiple keys)", { timeout: 60000 }, async () => {
    for (const s of ["sa_integration_test_assert", "sa_integration_test_assertions_assert"]) {
      await dbadapter.execute(`drop schema if exists "${s}" cascade`).catch(() => undefined);
    }

    const compiledGraph = await compile("tests/integration/postgres_assertion_project", "assert");

    // The compiler auto-creates one assertion per uniqueKey — single column
    // (dup_table), and multiple keys incl. a multi-column one (unique_table).
    const names = compiledGraph.assertions.map(a => targetAsReadableString(a.target));
    expect(names.some(n => n.includes("dup_table") && n.includes("uniqueKey"))).to.equal(true);
    expect(names.filter(n => n.includes("unique_table") && n.includes("uniqueKey")).length).to.equal(2);

    const executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    const executed = await dfapi.run(dbadapter, executionGraph).result();
    const assertionsMatching = (pred: (name: string) => boolean) =>
      executed.actions.filter(a => pred(targetAsReadableString(a.target)));

    // Single-column uniqueKey over duplicate data -> assertion FAILS (catches it).
    const dup = assertionsMatching(n => n.includes("dup_table") && n.includes("uniqueKey"));
    expect(dup.length).to.equal(1);
    expect(dup[0].status).to.equal(sqlanvil.ActionResult.ExecutionStatus.FAILED);

    // Multi-column (a,b) + single-column (c) uniqueKeys over unique data -> both PASS.
    const unique = assertionsMatching(n => n.includes("unique_table") && n.includes("uniqueKey"));
    expect(unique.length).to.equal(2);
    unique.forEach(a =>
      expect(a.status).to.equal(sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL)
    );

    for (const s of ["sa_integration_test_assert", "sa_integration_test_assertions_assert"]) {
      await dbadapter.execute(`drop schema if exists "${s}" cascade`).catch(() => undefined);
    }
  });
});
