import { expect } from "chai";

import { Runner } from "sa/cli/api/commands/run";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("runner import hook", () => {
  function makeRunner(calls: any[]) {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig: { warehouse: "postgres" },
      warehouseState: { tables: [] },
      actions: []
    });
    return new Runner({} as any, graph, {
      warehouseConnection: { host: "h", port: 5432, database: "d", user: "u", password: "p" },
      storageCredentials: { s3: { accessKeyId: "k", secretAccessKey: "s" } },
      duckdbImport: async (args: any) => {
        calls.push(args);
        return { source: "s3://b/o/orders.parquet" };
      }
    });
  }

  test("routes an import task to the DuckDB importer with spec + target", async () => {
    const calls: any[] = [];
    const runner = makeRunner(calls);
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "analytics", name: "orders" },
      type: "import",
      import: { location: "s3://b/o/*.parquet", format: "parquet", overwrite: true }
    });
    const actionResult: any = { tasks: [] };

    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "import" }),
      actionResult,
      {},
      action
    );

    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
    expect(calls).to.have.length(1);
    expect(calls[0].spec.location).equals("s3://b/o/*.parquet");
    expect(calls[0].target.name).equals("orders");
    expect(calls[0].pg.host).equals("h");
    expect(calls[0].storage.s3.accessKeyId).equals("k");
  });

  test("a failing importer marks the task FAILED", async () => {
    const runner = new Runner(
      {} as any,
      sqlanvil.ExecutionGraph.create({
        projectConfig: { warehouse: "supabase" },
        warehouseState: { tables: [] },
        actions: []
      }),
      {
        duckdbImport: async () => {
          throw new Error("boom");
        }
      }
    );
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "analytics", name: "orders" },
      type: "import",
      import: { location: "s3://b/o/*.parquet", format: "parquet" }
    });
    const actionResult: any = { tasks: [] };
    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "import" }),
      actionResult,
      {},
      action
    );
    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
    expect(actionResult.tasks[0].errorMessage).contains("boom");
  });
});
