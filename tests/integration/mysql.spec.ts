import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import { readMysqlSchema } from "sa/cli/api/commands/introspect";
import { validate, ValidateDeps } from "sa/cli/api/commands/validate";
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

  test("mysql:{} engine + indexes apply on real MySQL/MariaDB", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    const adapter = new ExecutionSql({ warehouse: "mysql" }, "2.0.0");

    const table: sqlanvil.ITable = {
      enumType: sqlanvil.TableType.TABLE,
      target: { schema: database, name: "opts_table" },
      query: "select 1 as id, 'a' as label",
      mysql: {
        engine: "InnoDB",
        charset: "utf8mb4",
        indexes: [
          { columns: ["id"], unique: true },
          { name: "ix_label", columns: ["label"] }
        ]
      }
    };
    for (const task of adapter.publishTasks(table, { fullRefresh: true }).build()) {
      await dbadapter.execute(task.statement);
    }

    // Engine applied.
    const eng = await dbadapter.execute(
      `select engine from information_schema.tables where table_schema = '${database}' and table_name = 'opts_table'`
    );
    expect(String(eng.rows[0].engine ?? eng.rows[0].ENGINE).toUpperCase()).to.equal("INNODB");

    // Both indexes created, unique flag honored (non_unique = 0 for the unique one).
    const idx = await dbadapter.execute(
      `select index_name, non_unique from information_schema.statistics ` +
        `where table_schema = '${database}' and table_name = 'opts_table' and index_name <> 'PRIMARY' ` +
        `group by index_name, non_unique`
    );
    const byName = keyBy(idx.rows, (r: any) => String(r.index_name ?? r.INDEX_NAME));
    expect(Object.keys(byName)).to.include("ix_label");
    expect(byName["opts_table_id_key"], "derived unique index name").to.exist;
    expect(
      Number(byName["opts_table_id_key"].non_unique ?? byName["opts_table_id_key"].NON_UNIQUE)
    ).to.equal(0);

    await dbadapter.execute(`drop database if exists \`${database}\``);
  });

  test("pre_operations / post_operations execute around a table build (issue #44)", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`preop_marker\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`ops_t\``);
    const adapter = new ExecutionSql({ warehouse: "mysql" }, "2.0.0");

    const table: sqlanvil.ITable = {
      enumType: sqlanvil.TableType.TABLE,
      target: { schema: database, name: "ops_t" },
      query: "select 1 as id",
      // preOp creates an observable sentinel; postOp mutates the just-built table.
      preOps: [`create table \`${database}\`.\`preop_marker\` (id int)`],
      postOps: [`alter table \`${database}\`.\`ops_t\` add column extra int`]
    };
    for (const task of adapter.publishTasks(table, { fullRefresh: true }).build()) {
      await dbadapter.execute(task.statement);
    }

    // preOp ran: the sentinel table exists.
    const marker = await dbadapter.table({ schema: database, name: "preop_marker" });
    expect(marker, "preOp should have created preop_marker").to.not.equal(null);

    // postOp ran: the column it added is present on the built table.
    const meta = await dbadapter.table({ schema: database, name: "ops_t" });
    expect(meta.fields.map(f => f.name)).to.include("extra");

    await dbadapter.execute(`drop database if exists \`${database}\``);
  });

  test("metadata: table + column comments applied and read back; NOT NULL preserved", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`meta_t\``);
    // CTAS from literals → id and label come out NOT NULL on MySQL 8 / MariaDB 11
    // (asserted below before the MODIFY, so the fidelity check isn't vacuous).
    await dbadapter.execute(`create table \`${database}\`.\`meta_t\` as select 1 as id, 'a' as label`);

    const nullabilityOf = async (col: string) =>
      String(
        (
          await dbadapter.execute(
            `select is_nullable as nullable from information_schema.columns ` +
              `where table_schema = '${database}' and table_name = 'meta_t' and column_name = '${col}'`
          )
        ).rows[0].nullable
      ).toUpperCase();
    expect(await nullabilityOf("id"), "id starts NOT NULL").to.equal("NO");

    await dbadapter.setMetadata({
      target: { schema: database, name: "meta_t" },
      tableType: "table",
      actionDescriptor: {
        description: "a table's 'desc'",
        columns: [
          { path: ["id"], description: "the id" },
          { path: ["label"], description: "the label" }
        ]
      }
    });

    const meta = await dbadapter.table({ schema: database, name: "meta_t" });
    expect(meta.description).to.equal("a table's 'desc'");
    const byName = keyBy(meta.fields, f => f.name);
    expect(byName["id"].description).to.equal("the id");
    expect(byName["label"].description).to.equal("the label");

    // Fidelity: the comment MODIFY must not have dropped NOT NULL.
    expect(await nullabilityOf("id"), "id still NOT NULL after comment").to.equal("NO");

    await dbadapter.execute(`drop database if exists \`${database}\``);
  });

  test("materialized view builds + refreshes a real table snapshot", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`mv_src\``);
    await dbadapter.execute(`drop view if exists \`${database}\`.\`mv\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`mv\``);
    await dbadapter.execute(`create table \`${database}\`.\`mv_src\` (id int)`);
    await dbadapter.execute(`insert into \`${database}\`.\`mv_src\` values (1), (2)`);

    const adapter = new ExecutionSql({ warehouse: "mysql" }, "2.0.0");
    const mv: sqlanvil.ITable = {
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      target: { schema: database, name: "mv" },
      query: `select count(*) as n from \`${database}\`.\`mv_src\``
    };

    const runMv = async () => {
      for (const task of adapter.publishTasks(mv, { fullRefresh: false }).build()) {
        await dbadapter.execute(task.statement);
      }
    };

    // First build → a real, queryable TABLE holding the snapshot.
    await runMv();
    const meta = await dbadapter.table({ schema: database, name: "mv" });
    expect(meta.type).to.equal(sqlanvil.TableMetadata.Type.TABLE);
    let n = await dbadapter.execute(`select n from \`${database}\`.\`mv\``);
    expect(Number(n.rows[0].n)).to.equal(2);

    // Change source, re-run → snapshot refreshes.
    await dbadapter.execute(`insert into \`${database}\`.\`mv_src\` values (3)`);
    await runMv();
    n = await dbadapter.execute(`select n from \`${database}\`.\`mv\``);
    expect(Number(n.rows[0].n)).to.equal(3);

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

  test("introspect: readMysqlSchema reads columns, types, and comments (issue #35)", { timeout: 30000 }, async () => {
    const database = "sa_integration_test_direct";
    await dbadapter.execute(`create database if not exists \`${database}\``);
    await dbadapter.execute(`drop table if exists \`${database}\`.\`intro_t\``);
    await dbadapter.execute(
      `create table \`${database}\`.\`intro_t\` (id int comment 'the id', label varchar(50))`
    );
    const resolved = {
      name: "src",
      definition: { platform: "mysql", host: MysqlFixture.host, port: MysqlFixture.port, database },
      credentials: {
        host: MysqlFixture.host,
        port: MysqlFixture.port,
        database,
        user: MysqlFixture.user,
        password: MysqlFixture.password
      }
    };
    const cols = await readMysqlSchema(resolved as any, database, "intro_t");
    const byName = keyBy(cols, (c: any) => c.name);
    expect(byName["id"].type).to.equal("int");
    expect(byName["id"].description).to.equal("the id");
    expect(byName["label"].type).to.equal("varchar");
    expect(byName["label"].description).to.equal(undefined);
    await dbadapter.execute(`drop database if exists \`${database}\``);
  });

  test("validate: clean DAG → PASS; broken → FAILURE + BLOCKED; shadow DB dropped", { timeout: 30000 }, async () => {
    const SHADOW = "sa_integration_validate";
    const ref = (name: string) => `\`${SHADOW}\`.\`${name}\``;
    const makeGraph = (midQuery: string): sqlanvil.ICompiledGraph =>
      ({
        tables: [
          sqlanvil.Table.create({
            enumType: sqlanvil.TableType.TABLE,
            target: { schema: SHADOW, name: "src" },
            query: "select 1 as id"
          }),
          sqlanvil.Table.create({
            enumType: sqlanvil.TableType.TABLE,
            target: { schema: SHADOW, name: "mid" },
            query: midQuery,
            dependencyTargets: [{ schema: SHADOW, name: "src" }]
          }),
          sqlanvil.Table.create({
            enumType: sqlanvil.TableType.TABLE,
            target: { schema: SHADOW, name: "leaf" },
            query: `select id from ${ref("mid")}`,
            dependencyTargets: [{ schema: SHADOW, name: "mid" }]
          })
        ],
        assertions: [],
        operations: []
      } as sqlanvil.ICompiledGraph);
    const executionSql = new ExecutionSql({ warehouse: "mysql" }, "2.0.0");
    const deps: ValidateDeps = {
      evaluate: action => dbadapter.evaluate(action as any),
      execute: sql => dbadapter.execute(sql).then(() => undefined),
      validationStubSql: t => executionSql.validationStubSql(t),
      createSchemaSql: s => executionSql.createSchemaSql(s),
      dropSchemaCascadeSql: s => executionSql.dropSchemaCascadeSql(s),
      listSchemas: async () =>
        (
          (await dbadapter.execute("select schema_name as name from information_schema.schemata"))
            .rows || []
        ).map((r: any) => r.name)
    };
    const shadowExists = async () =>
      (
        await dbadapter.execute(
          `select schema_name from information_schema.schemata where schema_name = '${SHADOW}'`
        )
      ).rows.length > 0;

    // Clean DAG → all PASS, shadow database created + dropped.
    await dbadapter.execute(`drop database if exists \`${SHADOW}\``);
    let byName = keyBy(await validate(makeGraph(`select id from ${ref("src")}`), deps), r => r.target.name);
    expect(byName["src"].status).to.equal("PASS");
    expect(byName["mid"].status).to.equal("PASS");
    expect(byName["leaf"].status).to.equal("PASS");
    expect(await shadowExists()).to.equal(false);

    // Broken mid → FAILURE; leaf BLOCKED; shadow still dropped.
    await dbadapter.execute(`drop database if exists \`${SHADOW}\``);
    byName = keyBy(
      await validate(makeGraph(`select nonexistent_col from ${ref("src")}`), deps),
      r => r.target.name
    );
    expect(byName["src"].status).to.equal("PASS");
    expect(byName["mid"].status).to.equal("FAILURE");
    expect(byName["leaf"].status).to.equal("BLOCKED");
    expect(await shadowExists()).to.equal(false);
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
