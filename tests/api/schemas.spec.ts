import { config, expect } from "chai";
import Long from "long";
import { anyString, anything, instance, mock, verify, when } from "ts-mockito";

import { Runner } from "sa/cli/api";
import { IDbAdapter } from "sa/cli/api/dbadapters";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import {
  buildDryRunValidationQueries,
  dryRunValidationQueryKey,
} from "sa/cli/api/utils/dry_run_validation";
import { wrapWithCreateSchemaIfNotExists } from "sa/cli/api/utils/query_transforms";
import { sleep, sleepUntil } from "sa/common/promises";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

config.truncateThreshold = 0;

suite("schema creation", () => {
  const projectConfig: sqlanvil.IProjectConfig = {
    warehouse: "bigquery",
    defaultDatabase: "db",
    defaultSchema: "new_ds",
    assertionSchema: "new_assertions",
  };

  const tableAction = (
    name: string,
    schema: string,
    statements: string[],
    dependencies: string[] = [],
  ): sqlanvil.IExecutionAction => ({
    type: "table",
    tableType: "table",
    target: { database: "db", schema, name },
    tasks: statements.map((statement) => ({ type: "statement", statement })),
    dependencyTargets: dependencies.map((dependency) => ({
      database: "db",
      schema,
      name: dependency,
    })),
  });

  const wrapped = (schema: string, statement: string) =>
    wrapWithCreateSchemaIfNotExists("db", schema, statement);

  function mockDbAdapter(
    existingSchemas: string[][] = [["existing_ds"]],
    executeImpl: (statement: string, options?: any) => Promise<any> = async () => ({
      rows: [],
      metadata: {},
    }),
  ) {
    const mockedDbAdapter = mock(BigQueryDbAdapter);
    const executedStatements: string[] = [];
    let schemasCall = when(mockedDbAdapter.schemas(anyString()));
    existingSchemas.forEach((schemas) => (schemasCall = schemasCall.thenResolve(schemas)));
    when(mockedDbAdapter.execute(anyString(), anything())).thenCall(
      async (statement: string, options: any) => {
        executedStatements.push(statement);
        return executeImpl(statement, options);
      },
    );
    // The Runner runs each action's tasks inside withClientLock, which a mock doesn't implement.
    const adapter = instance(mockedDbAdapter);
    adapter.withClientLock = async (callback) => await callback(adapter);
    return { mockedDbAdapter, adapter, executedStatements };
  }

  test("creates missing datasets in the first job of the first action writing to them", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a", "SECOND TASK a"]),
        tableAction("b", "new_ds", ["CREATE TABLE b"], ["a"]),
        tableAction("c", "existing_ds", ["CREATE TABLE c"]),
        {
          type: "assertion",
          target: { database: "db", schema: "new_assertions", name: "d" },
          tasks: [
            { type: "statement", statement: "CREATE VIEW d" },
            { type: "assertion", statement: "SELECT SUM(1) FROM d" },
          ],
          dependencyTargets: [],
        },
        {
          type: "table",
          tableType: "table",
          target: { database: "disabled_db", schema: "disabled_ds", name: "disabled" },
          tasks: [],
          dependencyTargets: [],
        },
      ],
    });
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter();

    const result = await new Runner(adapter, graph).execute().result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    verify(mockedDbAdapter.schemas("disabled_db")).never();
    expect(executedStatements).to.have.members([
      wrapped("new_ds", "CREATE TABLE a"),
      // The dataset was created by the first task, so later tasks aren't wrapped.
      "SECOND TASK a",
      // The dataset was created by "a", so "b" isn't wrapped.
      "CREATE TABLE b",
      // Existing datasets are never created.
      "CREATE TABLE c",
      wrapped("new_assertions", "CREATE VIEW d"),
      // Assertion tasks are never wrapped.
      "SELECT SUM(1) FROM d",
    ]);
    expect(executedStatements).to.have.length(6);
  });

  test("only one job at a time creates a missing dataset", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        tableAction("b", "new_ds", ["CREATE TABLE b"]),
      ],
    });
    let aStarted = false;
    let releaseA = false;
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
      [["existing_ds"]],
      async (statement) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          aStarted = true;
          await sleepUntil(() => releaseA);
        }
        return { rows: [], metadata: {} };
      },
    );

    const execution = new Runner(adapter, graph).execute().result();
    await sleepUntil(() => aStarted);
    // Give "b" the chance to start, which it mustn't while "a" is creating the dataset.
    await sleep(50);
    expect(executedStatements).deep.equals([wrapped("new_ds", "CREATE TABLE a")]);
    releaseA = true;
    const result = await execution;

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    // "a" created the dataset, so "b" isn't wrapped.
    expect(executedStatements).deep.equals([wrapped("new_ds", "CREATE TABLE a"), "CREATE TABLE b"]);
  });

  test("the next action writing to the dataset creates it if the creating action failed", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a", "SECOND TASK a"]),
        tableAction("b", "new_ds", ["CREATE TABLE b"]),
      ],
    });
    let bStarted = false;
    let releaseB = false;
    let aFinished = false;
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
      [["existing_ds"]],
      async (statement) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          throw new Error("a failed");
        }
        if (statement === wrapped("new_ds", "CREATE TABLE b")) {
          bStarted = true;
          await sleepUntil(() => releaseB);
        }
        return { rows: [], metadata: {} };
      },
    );

    const runner = Runner.create(adapter, graph, {}, 0);
    runner.onChange((runResult) => {
      const actionA = runResult.actions.find((action) => action.target.name === "a");
      if (actionA?.status === sqlanvil.ActionResult.ExecutionStatus.FAILED) {
        aFinished = true;
      }
    });
    const execution = runner.execute().result();
    await sleepUntil(() => bStarted);
    // "SECOND TASK a" is skipped without waiting for "b" to create the dataset.
    await sleep(50);
    const aFinishedWhileBRunning = aFinished;
    releaseB = true;
    const result = await execution;

    expect(aFinishedWhileBRunning).equals(true);
    expect(
      result.actions.map((action) => [action.target.name, action.status]),
    ).to.have.deep.members([
      ["a", sqlanvil.ActionResult.ExecutionStatus.FAILED],
      ["b", sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL],
    ]);
    expect(executedStatements).deep.equals([
      wrapped("new_ds", "CREATE TABLE a"),
      wrapped("new_ds", "CREATE TABLE b"),
    ]);
  });

  test("marks actions waiting for dataset creation as cancelled when the run is cancelled", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        {
          ...tableAction("b", "new_ds", ["CREATE TABLE b"]),
          actionDescriptor: { description: "table b" },
        },
        tableAction("c", "new_ds", ["CREATE TABLE c"], ["b"]),
      ],
    });
    let aStarted = false;
    let bRunning = false;
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
      [["existing_ds"]],
      (statement, options) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          aStarted = true;
          return new Promise((_, reject) => {
            options.onCancel(() => reject(new Error("Query cancelled.")));
          });
        }
        return Promise.resolve({ rows: [], metadata: {} });
      },
    );

    const runner = Runner.create(adapter, graph, {}, 0);
    runner.onChange((runResult) => {
      const actionB = runResult.actions.find((action) => action.target.name === "b");
      if (actionB?.status === sqlanvil.ActionResult.ExecutionStatus.RUNNING) {
        bRunning = true;
      }
    });
    const execution = runner.execute().result();
    await sleepUntil(() => aStarted && bRunning);
    runner.cancel();
    const result = await execution;

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.CANCELLED);
    expect(
      result.actions.map((action) => [action.target.name, action.status]),
    ).to.have.deep.members([
      ["a", sqlanvil.ActionResult.ExecutionStatus.CANCELLED],
      ["b", sqlanvil.ActionResult.ExecutionStatus.CANCELLED],
      ["c", sqlanvil.ActionResult.ExecutionStatus.SKIPPED],
    ]);
    const actionB = result.actions.find((action) => action.target.name === "b");
    expect(actionB.tasks).deep.equals([
      {
        status: sqlanvil.TaskResult.ExecutionStatus.SKIPPED,
        errorMessage: "Run cancelled",
      },
    ]);
    verify(mockedDbAdapter.setMetadata(anything())).never();
    expect(executedStatements).deep.equals([wrapped("new_ds", "CREATE TABLE a")]);
  });

  test("operations only create their target dataset if they have an output", async () => {
    const operation = (name: string, schema: string, hasOutput: boolean) => ({
      type: "operation",
      target: { database: "db", schema, name },
      hasOutput,
      tasks: [{ type: "statement", statement: `OPERATION ${name}` }],
      dependencyTargets: [] as sqlanvil.ITarget[],
    });
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        operation("with_output", "new_ds", true),
        // Its target dataset is never created, even though it doesn't exist.
        operation("without_output", "new_ds_2", false),
      ],
    });
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter();

    const result = await new Runner(adapter, graph).execute().result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    expect(executedStatements).to.have.members([
      wrapped("new_ds", "OPERATION with_output"),
      "OPERATION without_output",
    ]);
  });

  test("operations without an output don't wait for their target dataset to be created", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        {
          type: "operation",
          target: { database: "db", schema: "new_ds", name: "op" },
          hasOutput: false,
          tasks: [{ type: "statement", statement: "OPERATION" }],
          dependencyTargets: [],
        },
      ],
    });
    let operationStarted = false;
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
      [["existing_ds"]],
      async (statement) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          // Would never finish if the operation waited for "a" to create the dataset.
          await sleepUntil(() => operationStarted);
        }
        if (statement === "OPERATION") {
          operationStarted = true;
        }
        return { rows: [], metadata: {} };
      },
    );

    const result = await new Runner(adapter, graph).execute().result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    expect(executedStatements).to.have.members([wrapped("new_ds", "CREATE TABLE a"), "OPERATION"]);
  });

  test("in dry runs, wraps every action writing to a missing dataset and reports the SQL sent for wrapped tasks", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        tableAction("b", "new_ds", ["CREATE TABLE b"], ["a"]),
        tableAction("c", "existing_ds", ["CREATE TABLE c"]),
      ],
    });
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter();

    const result = await new Runner(adapter, graph, {
      bigquery: { dryRun: true },
    })
      .execute()
      .result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    // Dry runs don't create the dataset, so "b" is wrapped too.
    expect(executedStatements).to.have.members([
      wrapped("new_ds", "CREATE TABLE a"),
      wrapped("new_ds", "CREATE TABLE b"),
      "CREATE TABLE c",
    ]);
    expect(
      result.actions.map((action) => [action.target.name, action.tasks[0].compiledSql]),
    ).to.have.deep.members([
      ["a", wrapped("new_ds", "CREATE TABLE a")],
      ["b", wrapped("new_ds", "CREATE TABLE b")],
      // sqlanvil only reports the SQL sent when it differs from the task's statement.
      ["c", undefined],
    ]);
  });

  test("in real runs, reports the SQL sent for wrapped tasks only", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        tableAction("c", "existing_ds", ["CREATE TABLE c"]),
      ],
    });
    const { adapter } = mockDbAdapter();

    const result = await new Runner(adapter, graph).execute().result();

    expect(
      result.actions.map((action) => [action.target.name, action.tasks[0].compiledSql]),
    ).to.have.deep.members([
      // Error positions refer to the wrapped SQL, so it's what is shown.
      ["a", wrapped("new_ds", "CREATE TABLE a")],
      // Unwrapped tasks show their own statement, as before.
      ["c", undefined],
    ]);
  });

  test("in dry runs, actions writing to the same missing dataset run concurrently", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        tableAction("b", "new_ds", ["CREATE TABLE b"]),
      ],
    });
    let bStarted = false;
    const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
      [["existing_ds"]],
      async (statement) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          // Would never finish if "b" waited for "a".
          await sleepUntil(() => bStarted);
        }
        if (statement === wrapped("new_ds", "CREATE TABLE b")) {
          bStarted = true;
        }
        return { rows: [], metadata: {} };
      },
    );

    const result = await new Runner(adapter, graph, {
      bigquery: { dryRun: true },
    })
      .execute()
      .result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    expect(executedStatements).to.have.members([
      wrapped("new_ds", "CREATE TABLE a"),
      wrapped("new_ds", "CREATE TABLE b"),
    ]);
  });

  // sqlanvil: tasks the runner runs itself (scripts), and actions that don't write to their
  // target (exports), never create a dataset.
  test("script tasks are never wrapped and never wait for a dataset creation", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        {
          type: "script",
          target: { database: "db", schema: "new_ds", name: "stage_files" },
          tasks: [{ type: "script", statement: "" }],
          script: { language: "python", filename: "scripts/stage.py" },
          dependencyTargets: [],
        },
      ],
    });
    let scriptRan = false;
    const { adapter, executedStatements } = mockDbAdapter([["existing_ds"]], async (statement) => {
      if (statement === wrapped("new_ds", "CREATE TABLE a")) {
        // Would never finish if the script waited for "a" to create the dataset.
        await sleepUntil(() => scriptRan);
      }
      return { rows: [], metadata: {} };
    });

    const result = await new Runner(adapter, graph, {
      scriptRun: async () => {
        scriptRan = true;
        return { exitCode: 0 };
      },
    })
      .execute()
      .result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    expect(executedStatements).deep.equals([wrapped("new_ds", "CREATE TABLE a")]);
  });

  test("exports don't create their target dataset; imports do", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        {
          type: "export",
          target: { database: "db", schema: "new_ds", name: "exp" },
          tasks: [{ type: "statement", statement: "EXPORT DATA" }],
          dependencyTargets: [],
        },
        {
          type: "import",
          target: { database: "db", schema: "new_ds_2", name: "imp" },
          tasks: [{ type: "statement", statement: "LOAD DATA" }],
          dependencyTargets: [],
        },
      ],
    });
    const { adapter, executedStatements } = mockDbAdapter();

    const result = await new Runner(adapter, graph).execute().result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    expect(executedStatements).to.have.members(["EXPORT DATA", wrapped("new_ds_2", "LOAD DATA")]);
  });

  test("postgres runs create schemas up front and never wrap", async () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig: { ...projectConfig, warehouse: "postgres" },
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a"]),
        tableAction("b", "existing_ds", ["CREATE TABLE b"]),
      ],
    });
    const mockedDbAdapter = mock<IDbAdapter>();
    const executedStatements: string[] = [];
    when(mockedDbAdapter.schemas(anything())).thenResolve(["existing_ds"]);
    when(mockedDbAdapter.createSchema(anything(), anyString(), anything())).thenResolve();
    when(mockedDbAdapter.execute(anyString(), anything())).thenCall(async (statement: string) => {
      executedStatements.push(statement);
      return { rows: [], metadata: {} };
    });
    const adapter = instance(mockedDbAdapter);
    adapter.withClientLock = async (callback) => await callback(adapter);

    const result = await new Runner(adapter, graph).execute().result();

    expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
    verify(mockedDbAdapter.createSchema("db", "new_ds", anything())).once();
    verify(mockedDbAdapter.createSchema("db", "existing_ds", anything())).never();
    expect(executedStatements).to.have.members(["CREATE TABLE a", "CREATE TABLE b"]);
  });

  suite("dry-run validation queries", () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [
        tableAction("a", "new_ds", ["CREATE TABLE a AS SELECT a"]),
        tableAction("c", "existing_ds", ["CREATE TABLE c AS SELECT c"]),
        {
          type: "operation",
          target: { database: "db", schema: "new_ds", name: "op" },
          hasOutput: true,
          tasks: [{ type: "statement", statement: "OPERATION" }],
          dependencyTargets: [],
        },
      ],
    });
    const dryRunValidationQueries = new Map([
      [dryRunValidationQueryKey({ database: "db", schema: "new_ds", name: "a" }), "SELECT a"],
      [dryRunValidationQueryKey({ database: "db", schema: "existing_ds", name: "c" }), "SELECT c"],
    ]);

    test("dry-runs the query of actions writing to a missing dataset", async () => {
      const validationMetadata: sqlanvil.IExecutionMetadata = {
        bigquery: { totalBytesProcessed: Long.fromNumber(123) },
      };
      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
        [["existing_ds"]],
        async (statement) => ({
          rows: [],
          metadata: statement === "SELECT a" ? validationMetadata : {},
        }),
      );

      const result = await new Runner(adapter, graph, {
        bigquery: { dryRun: true },
        dryRunValidationQueries,
      })
        .execute()
        .result();

      expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      expect(executedStatements).to.have.members([
        wrapped("new_ds", "CREATE TABLE a AS SELECT a"),
        "SELECT a",
        // Not wrapped, so fully checked already.
        "CREATE TABLE c AS SELECT c",
        // No query to validate separately.
        wrapped("new_ds", "OPERATION"),
      ]);
      expect(executedStatements).to.have.length(4);
      const actionA = result.actions.find((action) => action.target.name === "a");
      expect(actionA.tasks[0].metadata).deep.equals(validationMetadata);
    });

    test("reports a failure of the query on the action's task after retries", async () => {
      let attempts = 0;
      let validationEndMillis = 0;
      const { adapter } = mockDbAdapter([["existing_ds"]], async (statement) => {
        if (statement === "SELECT a") {
          attempts++;
          await sleep(10);
          validationEndMillis = Date.now();
          throw new Error("Query error: Unrecognized name: a at [1:8]");
        }
        return { rows: [], metadata: {} };
      });
      const observedStatuses: sqlanvil.TaskResult.ExecutionStatus[] = [];
      const runner = Runner.create(
        adapter,
        graph,
        {
          bigquery: { dryRun: true, actionRetryLimit: 1 },
          dryRunValidationQueries,
        },
        0,
      );
      runner.onChange((runResult) => {
        const actionA = runResult.actions.find((action) => action.target.name === "a");
        const status = actionA?.tasks[0]?.status;
        if (status !== undefined) {
          observedStatuses.push(status);
        }
      });

      const result = await runner.execute().result();

      expect(attempts).equals(2);
      expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.FAILED);
      // Listeners never see the task as SUCCESSFUL before the validation query fails.
      expect(observedStatuses).not.to.include(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
      const actionA = result.actions.find((action) => action.target.name === "a");
      expect(actionA.status).equals(sqlanvil.ActionResult.ExecutionStatus.FAILED);
      expect(actionA.tasks).to.have.length(1);
      expect(actionA.tasks[0].status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
      const endMillis = actionA.tasks[0].timing.endTimeMillis.toNumber();
      expect(endMillis).to.be.at.least(validationEndMillis);
      // The position is mapped to the wrapped statement shown as the compiled SQL: 2 lines down
      // for the wrapper, and after the `CREATE TABLE a AS ` before the query on its line.
      expect(actionA.tasks[0].errorMessage).equals(
        "bigquery error: Query error: Unrecognized name: a at [3:26]",
      );
      expect(actionA.tasks[0].compiledSql).equals(wrapped("new_ds", "CREATE TABLE a AS SELECT a"));
    });

    test("maps error positions to the compiled SQL when the query follows `create or replace … as` on the same line", async () => {
      // E.g. `publish("t", "SELECT …")` in JS, unlike SQLX queries which start with a line break.
      const table = sqlanvil.Table.create({
        target: { database: "db", schema: "new_ds", name: "inline" },
        enumType: sqlanvil.TableType.TABLE,
        preOps: ["DECLARE x INT64 DEFAULT 1"],
        query: "SELECT bad FROM src WHERE x > 0",
        bigquery: { partitionBy: "DATE(ts)" },
      });
      const [task] = new ExecutionSql(projectConfig, version).createTableTasks(table, {});
      const key = dryRunValidationQueryKey(table.target);
      const validationQuery = buildDryRunValidationQueries(
        sqlanvil.CompiledGraph.create({ tables: [table] }),
      ).get(key);
      expect(validationQuery).equals("DECLARE x INT64 DEFAULT 1;\nSELECT bad FROM src WHERE x > 0");
      const inlineGraph = sqlanvil.ExecutionGraph.create({
        projectConfig,
        runConfig: {},
        warehouseState: {},
        actions: [
          {
            type: "table",
            tableType: "table",
            target: table.target,
            tasks: [task],
            dependencyTargets: [],
          },
        ],
      });
      const { adapter } = mockDbAdapter([["existing_ds"]], async (statement) => {
        if (statement === validationQuery) {
          // Position of `bad` in the validation query.
          throw new Error("Query error: Unrecognized name: bad at [2:8]");
        }
        return { rows: [], metadata: {} };
      });

      const result = await new Runner(adapter, inlineGraph, {
        bigquery: { dryRun: true },
        dryRunValidationQueries: new Map([[key, validationQuery]]),
      })
        .execute()
        .result();

      const taskResult = result.actions[0].tasks[0];
      expect(taskResult.status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
      // The compiled SQL is the wrapped statement, with the query on the line of
      // `create or replace table … partition by … as `.
      const compiledLines = taskResult.compiledSql.split("\n");
      expect(compiledLines[3]).to.match(
        /^create or replace table `db\.new_ds\.inline` partition by DATE\(ts\) as SELECT bad/,
      );
      const column = compiledLines[3].indexOf("bad") + 1;
      expect(taskResult.errorMessage).equals(
        `bigquery error: Query error: Unrecognized name: bad at [4:${column}]`,
      );
    });

    test("doesn't dry-run the query if the wrapped script fails", async () => {
      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter(
        [["existing_ds"]],
        async (statement) => {
          if (statement === wrapped("new_ds", "CREATE TABLE a AS SELECT a")) {
            throw new Error("Syntax error");
          }
          return { rows: [], metadata: {} };
        },
      );

      await new Runner(adapter, graph, {
        bigquery: { dryRun: true },
        dryRunValidationQueries,
      })
        .execute()
        .result();

      expect(executedStatements).not.to.include("SELECT a");
    });

    test("are ignored outside of dry runs", async () => {
      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter();

      await new Runner(adapter, graph, { dryRunValidationQueries }).execute().result();

      expect(executedStatements).not.to.include("SELECT a");
    });

    test("are built from the tables and assertions of the compiled graph", () => {
      const queries = buildDryRunValidationQueries(
        sqlanvil.CompiledGraph.create({
          tables: [
            { target: { database: "db", schema: "ds", name: "table" }, query: "SELECT 1" },
            {
              target: { database: "db", schema: "ds", name: "with_ops" },
              preOps: ["DECLARE x INT64 DEFAULT 1"],
              query: "SELECT x",
              postOps: ["SET x = 2"],
            },
            {
              target: { database: "db", schema: "ds", name: "disabled" },
              query: "SELECT 2",
              disabled: true,
            },
          ],
          assertions: [
            { target: { database: "db", schema: "ds_assertions", name: "a" }, query: "SELECT 3" },
          ],
          operations: [
            { target: { database: "db", schema: "ds", name: "op" }, queries: ["SELECT 4"] },
          ],
        }),
      );

      expect(Array.from(queries.entries())).to.have.deep.members([
        [dryRunValidationQueryKey({ database: "db", schema: "ds", name: "table" }), "SELECT 1"],
        [
          dryRunValidationQueryKey({ database: "db", schema: "ds", name: "with_ops" }),
          "DECLARE x INT64 DEFAULT 1;\nSELECT x",
        ],
        [
          dryRunValidationQueryKey({ database: "db", schema: "ds_assertions", name: "a" }),
          "SELECT 3",
        ],
      ]);
    });

    test("have the same lines as the executed statement up to the end of the query", () => {
      const table = sqlanvil.Table.create({
        target: { database: "db", schema: "ds", name: "t" },
        enumType: sqlanvil.TableType.TABLE,
        preOps: ["DECLARE x INT64 DEFAULT 1", "SET x = 2 -- comment"],
        // Compiled SQLX queries start with line breaks, which the statement keeps after `as `.
        query: "\n\n  SELECT x,\n    y\n  FROM src\n",
        postOps: ["SELECT 1"],
        bigquery: { partitionBy: "DATE(ts)", clusterBy: ["y"] },
      });
      const [task] = new ExecutionSql(projectConfig, version).createTableTasks(table, {});
      const statementLines = task.statement.split("\n");

      const queryLines = buildDryRunValidationQueries(
        sqlanvil.CompiledGraph.create({ tables: [table] }),
      )
        .get(dryRunValidationQueryKey(table.target))
        .split("\n");

      // The statement has postOps after the query (and a `;` terminating the query before them).
      expect(queryLines).to.have.length(statementLines.length - 1);
      // All query lines match the statement, except the one where the query starts (`create or
      // replace table … as ` vs nothing) and the trailing `;` added before postOps.
      const queryStartLine = 2;
      expect(statementLines[queryStartLine]).to.match(/^create or replace table .* as\s*$/);
      expect(queryLines[queryStartLine]).equals("");
      queryLines.forEach((line, i) => {
        if (i === queryStartLine) {
          return;
        }
        if (i === queryLines.length - 1) {
          expect(`${line};`).equals(statementLines[i]);
        } else {
          expect(line).equals(statementLines[i]);
        }
      });
    });
  });

  suite("resume", () => {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig,
      runConfig: {},
      warehouseState: {},
      actions: [tableAction("a", "new_ds", ["CREATE TABLE a", "SECOND TASK a"])],
    });

    async function runUntilFirstTaskThenStop() {
      let firstTaskInProgress = false;
      let stopWasCalled = false;
      const { adapter } = mockDbAdapter([[]], async (statement) => {
        if (statement === wrapped("new_ds", "CREATE TABLE a")) {
          firstTaskInProgress = true;
          await sleepUntil(() => stopWasCalled);
        }
        return { rows: [], metadata: {} };
      });
      const runner = new Runner(adapter, graph);
      runner.execute();
      await sleepUntil(() => firstTaskInProgress);
      runner.stop();
      stopWasCalled = true;
      return await runner.result();
    }

    test("wraps the first not-yet-executed task if the dataset is still missing", async () => {
      const partialResult = await runUntilFirstTaskThenStop();

      // E.g. the first job was interrupted before creating the dataset.
      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter([[]]);
      const result = await Runner.resume(adapter, graph, partialResult).execute().result();

      expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      expect(executedStatements).deep.equals([wrapped("new_ds", "SECOND TASK a")]);
    });

    test("doesn't wrap tasks writing to datasets created before the interruption", async () => {
      const partialResult = await runUntilFirstTaskThenStop();

      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter([["new_ds"]]);
      await Runner.resume(adapter, graph, partialResult).execute().result();

      expect(executedStatements).deep.equals(["SECOND TASK a"]);
    });

    test("doesn't list datasets of databases whose actions have all completed", async () => {
      const multiDbGraph = sqlanvil.ExecutionGraph.create({
        projectConfig,
        runConfig: {},
        warehouseState: {},
        actions: [
          {
            type: "table",
            tableType: "table",
            target: { database: "completed_db", schema: "ds", name: "done" },
            tasks: [{ type: "statement", statement: "CREATE TABLE done" }],
            dependencyTargets: [],
          },
          tableAction("pending", "new_ds", ["CREATE TABLE pending"]),
        ],
      });
      const partialResult: sqlanvil.IRunResult = {
        actions: [
          {
            target: { database: "completed_db", schema: "ds", name: "done" },
            status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
            tasks: [{ status: sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL }],
          },
        ],
      };
      const { mockedDbAdapter, adapter, executedStatements } = mockDbAdapter([[]]);

      const result = await Runner.resume(adapter, multiDbGraph, partialResult).execute().result();

      expect(result.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      verify(mockedDbAdapter.schemas("completed_db")).never();
      expect(executedStatements).deep.equals([wrapped("new_ds", "CREATE TABLE pending")]);
    });
  });
});
