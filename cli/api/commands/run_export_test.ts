import { expect } from "chai";

import { Runner } from "sa/cli/api/commands/run";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("runner export hook", () => {
  function makeRunner(calls: any[]) {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig: { warehouse: "postgres" },
      warehouseState: { tables: [] },
      actions: []
    });
    return new Runner({} as any, graph, {
      warehouseConnection: { host: "h", port: 5432, database: "d", user: "u", password: "p" },
      storageCredentials: { s3: { accessKeyId: "k", secretAccessKey: "s" } },
      duckdbExport: async (args: any) => {
        calls.push(args);
        return { destination: "s3://b/o/orders.parquet" };
      }
    });
  }

  test("routes an export task to the DuckDB exporter with spec + SELECT", async () => {
    const calls: any[] = [];
    const runner = makeRunner(calls);
    const action = sqlanvil.ExecutionAction.create({
      target: { name: "orders" },
      type: "export",
      export: { location: "s3://b/o/", format: "parquet", filename: "orders" }
    });
    const actionResult: any = { tasks: [] };

    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "export", statement: "SELECT 1 AS id" }),
      actionResult,
      {},
      action
    );

    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
    expect(calls).to.have.length(1);
    expect(calls[0].selectSql).equals("SELECT 1 AS id");
    expect(calls[0].spec.location).equals("s3://b/o/");
    expect(calls[0].pg.host).equals("h");
    expect(calls[0].storage.s3.accessKeyId).equals("k");
  });

  test("a failing exporter marks the task FAILED", async () => {
    const runner = new Runner({} as any, sqlanvil.ExecutionGraph.create({
      projectConfig: { warehouse: "supabase" },
      warehouseState: { tables: [] },
      actions: []
    }), {
      duckdbExport: async () => {
        throw new Error("boom");
      }
    });
    const action = sqlanvil.ExecutionAction.create({
      target: { name: "orders" },
      type: "export",
      export: { location: "s3://b/o/", format: "parquet" }
    });
    const actionResult: any = { tasks: [] };
    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "export", statement: "SELECT 1" }),
      actionResult,
      {},
      action
    );
    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
    expect(actionResult.tasks[0].errorMessage).contains("boom");
  });
});
