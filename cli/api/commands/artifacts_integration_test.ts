import { expect } from "chai";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

import { writeArtifacts } from "sa/cli/api/commands/artifacts";
import { ArtifactView, queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

// Warehouse-agnostic: exercises only the bundled DuckDB (no DB container).
suite("artifacts integration", () => {
  test("writeArtifacts → Parquet → query back via DuckDB", { timeout: 60000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-artifacts-"));
    try {
      const graph: sqlanvil.ICompiledGraph = {
        tables: [
          {
            target: { schema: "s", name: "src" },
            enumType: sqlanvil.TableType.TABLE,
            tags: ["daily"],
            actionDescriptor: { columns: [{ path: ["id"], description: "the id" }] }
          },
          {
            target: { schema: "s", name: "v" },
            enumType: sqlanvil.TableType.VIEW,
            dependencyTargets: [{ schema: "s", name: "src" }]
          }
        ],
        assertions: [
          { target: { schema: "s", name: "a" }, dependencyTargets: [{ schema: "s", name: "v" }] }
        ],
        operations: [],
        exports: [],
        declarations: []
      } as sqlanvil.ICompiledGraph;

      const runResult: sqlanvil.IRunResult = {
        status: sqlanvil.RunResult.ExecutionStatus.FAILED,
        actions: [
          {
            target: { schema: "s", name: "src" },
            status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
            timing: { startTimeMillis: 1000, endTimeMillis: 1400 } as any,
            tasks: []
          },
          {
            target: { schema: "s", name: "v" },
            status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
            timing: { startTimeMillis: 1400, endTimeMillis: 1600 } as any,
            tasks: [{ errorMessage: "boom" } as any]
          }
        ]
      } as sqlanvil.IRunResult;

      await writeArtifacts(graph, dir, { runResult, runId: 123 });

      const t = path.join(dir, "target");
      const views: ArtifactView[] = [
        { name: "actions", glob: path.join(t, "catalog/actions.parquet") },
        { name: "dependencies", glob: path.join(t, "catalog/dependencies.parquet") },
        { name: "columns", glob: path.join(t, "catalog/columns.parquet") },
        { name: "runs", glob: path.join(t, "runs/*.parquet") }
      ];

      const byType = await queryParquet(
        "select type, count(*) as n from actions group by type order by type",
        views
      );
      expect(byType.map((r: any) => `${r.type}:${Number(r.n)}`)).to.eql([
        "assertion:1",
        "table:1",
        "view:1"
      ]);

      const depCount = await queryParquet("select count(*) as n from dependencies", views);
      expect(Number(depCount[0].n)).to.equal(2);

      const cols = await queryParquet("select column_name, description from columns", views);
      expect(cols).to.eql([{ column_name: "id", description: "the id" }]);

      const runs = await queryParquet(
        "select status, error_message, duration_millis from runs",
        views
      );
      expect(runs.length).to.equal(2);
      const failed = runs.find((r: any) => r.status === "FAILED");
      expect(failed.error_message).to.equal("boom");
      expect(Number(failed.duration_millis)).to.equal(200);
      const ok = runs.find((r: any) => r.status === "SUCCESSFUL");
      expect(Number(ok.duration_millis)).to.equal(400);

      // Empty rowsets still produce queryable (0-row) Parquet.
      const emptyGraph = { tables: [], operations: [], assertions: [], exports: [], declarations: [] } as sqlanvil.ICompiledGraph;
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sa-artifacts-empty-"));
      try {
        await writeArtifacts(emptyGraph, dir2);
        const n = await queryParquet("select count(*) as n from actions", [
          { name: "actions", glob: path.join(dir2, "target/catalog/actions.parquet") }
        ]);
        expect(Number(n[0].n)).to.equal(0);
      } finally {
        fs.removeSync(dir2);
      }
    } finally {
      fs.removeSync(dir);
    }
  });
});
