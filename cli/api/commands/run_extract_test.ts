import { expect } from "chai";

import { Runner } from "sa/cli/api/commands/run";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("runner extract hook", () => {
  function makeRunner(bqCalls: any[], myCalls: any[]) {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig: { warehouse: "postgres" },
      warehouseState: { tables: [] },
      actions: []
    });
    return new Runner({} as any, graph, {
      warehouseConnection: { host: "h", port: 5432, database: "d", user: "u", password: "p" },
      connectionCredentials: { shop_mysql: { host: "m", user: "mu", password: "mp" } },
      bigQueryExtract: async (args: any) => {
        bqCalls.push(args);
        return { rowCount: 1 };
      },
      mysqlExtract: async (args: any) => {
        myCalls.push(args);
        return { rowCount: 2 };
      }
    });
  }

  test("routes a mysql extract to the mysql extractor with spec + target + credentials", async () => {
    const bqCalls: any[] = [];
    const myCalls: any[] = [];
    const runner = makeRunner(bqCalls, myCalls);
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "shop_mysql_ext", name: "orders" },
      type: "extract",
      extract: {
        connectionName: "shop_mysql",
        platform: "mysql",
        database: "shop",
        sourceName: "orders",
        columnTypes: { id: "bigint" }
      }
    });
    const actionResult: any = { tasks: [] };

    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "extract" }),
      actionResult,
      {},
      action
    );

    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
    expect(bqCalls).to.have.length(0);
    expect(myCalls).to.have.length(1);
    expect(myCalls[0].spec.database).equals("shop");
    expect(myCalls[0].target.name).equals("orders");
    expect(myCalls[0].pg.host).equals("h");
    expect(myCalls[0].connectionCredentials.shop_mysql.user).equals("mu");
  });

  test("routes a bigquery extract to the bigquery extractor (unchanged)", async () => {
    const bqCalls: any[] = [];
    const myCalls: any[] = [];
    const runner = makeRunner(bqCalls, myCalls);
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "bq_ext", name: "zip_codes" },
      type: "extract",
      extract: {
        connectionName: "bq",
        platform: "bigquery",
        project: "p",
        dataset: "ds",
        sourceName: "zip_codes",
        columnTypes: { zip_code: "text" }
      }
    });
    const actionResult: any = { tasks: [] };

    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "extract" }),
      actionResult,
      {},
      action
    );

    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
    expect(myCalls).to.have.length(0);
    expect(bqCalls).to.have.length(1);
    expect(bqCalls[0].spec.dataset).equals("ds");
  });

  test("a failing mysql extractor marks the task FAILED", async () => {
    const runner = new Runner(
      {} as any,
      sqlanvil.ExecutionGraph.create({
        projectConfig: { warehouse: "supabase" },
        warehouseState: { tables: [] },
        actions: []
      }),
      {
        mysqlExtract: async () => {
          throw new Error("boom");
        }
      }
    );
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "shop_mysql_ext", name: "orders" },
      type: "extract",
      extract: {
        connectionName: "shop_mysql",
        platform: "mysql",
        sourceName: "orders",
        columnTypes: { id: "bigint" }
      }
    });
    const actionResult: any = { tasks: [] };
    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "extract" }),
      actionResult,
      {},
      action
    );
    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
    expect(actionResult.tasks[0].errorMessage).contains("boom");
  });
});
