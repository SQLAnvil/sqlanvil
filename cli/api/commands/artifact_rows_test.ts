import { expect } from "chai";

import { catalogRows, runRows } from "sa/cli/api/commands/artifact_rows";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("artifact_rows", () => {
  const graph: sqlanvil.ICompiledGraph = {
    tables: [
      {
        target: { schema: "s", name: "src" },
        enumType: sqlanvil.TableType.TABLE,
        tags: ["daily"],
        dependencyTargets: [],
        actionDescriptor: { columns: [{ path: ["id"], description: "the id" }] }
      },
      {
        target: { schema: "s", name: "v" },
        enumType: sqlanvil.TableType.VIEW,
        dependencyTargets: [{ schema: "s", name: "src" }],
        actionDescriptor: { description: "a view" }
      }
    ],
    assertions: [{ target: { schema: "s", name: "a" }, dependencyTargets: [{ schema: "s", name: "v" }] }],
    operations: [],
    exports: [],
    declarations: []
  } as sqlanvil.ICompiledGraph;

  test("catalogRows: actions with types, deps, columns, tags", () => {
    const { actions, dependencies, columns } = catalogRows(graph);

    const byName = (n: string) => actions.find(a => a.name === n);
    expect(actions.length).to.equal(3);
    expect(byName("src").type).to.equal("table");
    expect(byName("v").type).to.equal("view");
    expect(byName("a").type).to.equal("assertion");
    expect(byName("src").tags).to.equal('["daily"]');
    expect(byName("v").description).to.equal("a view");
    expect(byName("src").disabled).to.equal(false);

    // Edges: v -> src, a -> v.
    expect(dependencies.map(d => `${d.from_readable}->${d.to_readable}`).sort()).to.eql([
      "s.a->s.v",
      "s.v->s.src"
    ]);

    expect(columns).to.eql([
      { target_key: columns[0].target_key, readable_name: "s.src", column_name: "id", description: "the id" }
    ]);
  });

  test("runRows: status strings, durations, error message", () => {
    const runResult: sqlanvil.IRunResult = {
      status: sqlanvil.RunResult.ExecutionStatus.FAILED,
      actions: [
        {
          target: { schema: "s", name: "src" },
          status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
          timing: { startTimeMillis: 1000, endTimeMillis: 1500 } as any,
          tasks: []
        },
        {
          target: { schema: "s", name: "v" },
          status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
          timing: { startTimeMillis: 1500, endTimeMillis: 1600 } as any,
          tasks: [{ errorMessage: "boom" } as any]
        }
      ]
    } as sqlanvil.IRunResult;

    const rows = runRows(runResult, 42);
    expect(rows.length).to.equal(2);
    expect(rows.every(r => r.run_id === 42 && r.run_status === "FAILED")).to.equal(true);

    const src = rows.find(r => r.readable_name === "s.src");
    expect(src.status).to.equal("SUCCESSFUL");
    expect(src.duration_millis).to.equal(500);
    expect(src.error_message).to.equal("");

    const v = rows.find(r => r.readable_name === "s.v");
    expect(v.status).to.equal("FAILED");
    expect(v.duration_millis).to.equal(100);
    expect(v.error_message).to.equal("boom");
  });
});
