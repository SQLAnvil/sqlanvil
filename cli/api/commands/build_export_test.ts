import { expect } from "chai";

import { Builder } from "sa/cli/api/commands/build";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("build exports", () => {
  test("an export compiles to an ExecutionAction with type export + ExportSpec", () => {
    const compiledGraph = sqlanvil.CompiledGraph.create({
      projectConfig: { warehouse: "postgres", defaultSchema: "public" },
      exports: [
        sqlanvil.Export.create({
          target: { schema: "public", name: "orders" },
          query: "SELECT 1 AS id",
          location: "s3://b/orders/",
          format: "parquet",
          overwrite: true,
          filename: "orders"
        })
      ]
    });

    const executionGraph = new Builder(compiledGraph, {}, { tables: [] }).build();

    const action = executionGraph.actions.find(a => a.type === "export");
    expect(action).to.exist;
    expect(action.export.location).equals("s3://b/orders/");
    expect(action.export.format).equals("parquet");
    expect(action.export.filename).equals("orders");
    expect(action.tasks).to.have.length(1);
    expect(action.tasks[0].type).equals("export");
    expect(action.tasks[0].statement).equals("SELECT 1 AS id");
  });
});
