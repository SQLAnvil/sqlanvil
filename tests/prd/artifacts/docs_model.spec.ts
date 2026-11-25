// The docs builder: FR-021 of docs/prd/sqlanvil/features/artifacts.md.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { writeArtifacts } from "sa/cli/api/commands/artifacts";
import { buildDocsModel } from "sa/cli/api/commands/docs";
import { writeParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { g1, r1, successfulEmptyRun } from "sa/tests/prd/artifacts/fixtures";
import { ABSENT, expectFields, withTmpDir } from "sa/tests/prd/artifacts/helpers";

const write: any = writeArtifacts;
const build: any = buildDocsModel;
const writePq: any = writeParquet;

const GENERATED_AT = "2026-06-24T00:00:00Z";

// The column lists of AC-001.2.
const ACTIONS_COLUMNS = [
  "target_key",
  "database",
  "schema",
  "name",
  "readable_name",
  "type",
  "tags",
  "disabled",
  "file_name",
  "description",
];
const DEPENDENCIES_COLUMNS = ["from_target_key", "to_target_key", "from_readable", "to_readable"];
const COLUMNS_COLUMNS = ["target_key", "readable_name", "column_name", "description"];

// The views of T-021.1 over P (testing.md, Harness, Layout): actions, dependencies and columns
// over P/target/catalog/<name>.parquet and, when asked, runs over P/target/runs/*.parquet.
function views(P: string, withRuns: boolean): Array<{ name: string; glob: string }> {
  const out = ["actions", "dependencies", "columns"].map((name) => ({
    name,
    glob: path.join(P, "target/catalog", `${name}.parquet`),
  }));
  if (withRuns) {
    out.push({ name: "runs", glob: path.join(P, "target/runs/*.parquet") });
  }
  return out;
}

function byReadable(model: any, readable: string): any {
  const found = (model.models || []).filter((m: any) => m.readable === readable);
  expect(found.length, `models with readable ${readable}`).to.equal(1);
  return found[0];
}

suite("prd artifacts: docs builder", () => {
  test("@prd T-021.1 returns one model per actions row, ordered by type then readable name", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const model = await build(views(P, true), GENERATED_AT);
      expectFields(model.models, [
        { readable: "s.a", type: "assertion", tags: [], description: "", dependsOn: ["s.v"] },
        {
          readable: "s.src",
          type: "table",
          tags: ["daily"],
          description: "source",
          status: "SUCCESSFUL",
          dependsOn: [],
        },
        {
          readable: "s.v",
          type: "view",
          tags: [],
          description: "",
          status: "FAILED",
          dependsOn: ["s.src"],
        },
      ], "models");
    });
  });

  test("@prd T-021.2 returns the summary and generatedAt", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const model = await build(views(P, true), GENERATED_AT);
      expectFields(model, {
        generatedAt: "2026-06-24T00:00:00Z",
        summary: {
          total: 3,
          byType: [
            { type: "assertion", n: 1 },
            { type: "table", n: 1 },
            { type: "view", n: 1 },
          ],
        },
      }, "model");
    });
  });

  test("@prd T-021.3 takes the latest run and each model's status in it", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 100 });
      await write(g1(), P, {
        runResult: {
          status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
          actions: [
            {
              target: { schema: "s", name: "v" },
              status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
              timing: { startTimeMillis: 1, endTimeMillis: 2 },
              tasks: [],
            },
          ],
        },
        runId: 200,
      });
      const model = await build(views(P, true), GENERATED_AT);
      expectFields(model, { latestRun: { runId: 200, status: "SUCCESSFUL" } }, "model");
      expectFields(byReadable(model, "s.v"), { status: "SUCCESSFUL" }, "s.v");
      expectFields(byReadable(model, "s.src"), { status: ABSENT }, "s.src");
      expectFields(byReadable(model, "s.a"), { status: ABSENT }, "s.a");
    });
  });

  test("@prd T-021.4 gives no latestRun and no status without a runs view", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const model = await build(views(P, false), GENERATED_AT);
      expectFields(model, { latestRun: ABSENT }, "model");
      expectFields(model.models, [{ status: ABSENT }, { status: ABSENT }, { status: ABSENT }], "models");
    });
  });

  test("@prd T-021.5 gives an empty tag list when tags is not valid JSON", async () => {
    await withTmpDir(async (P) => {
      const catalog = path.join(P, "target/catalog");
      fs.mkdirSync(catalog, { recursive: true });
      await writePq(
        [
          {
            target_key: "k",
            database: "",
            schema: "s",
            name: "x",
            readable_name: "s.x",
            type: "table",
            tags: "not json",
            disabled: false,
            file_name: "",
            description: "",
          },
        ],
        path.join(catalog, "actions.parquet"),
        ACTIONS_COLUMNS,
      );
      await writePq([], path.join(catalog, "dependencies.parquet"), DEPENDENCIES_COLUMNS);
      await writePq([], path.join(catalog, "columns.parquet"), COLUMNS_COLUMNS);
      const model = await build(views(P, false), GENERATED_AT);
      expectFields(model, {
        models: [{ readable: "s.x", type: "table", tags: [], description: "", dependsOn: [] }],
      }, "model");
    });
  });

  test("@prd T-021.6 returns one column entry per columns row, ordered by readable then column", async () => {
    await withTmpDir(async (P) => {
      const graph = {
        tables: [
          {
            target: { schema: "s", name: "zeta" },
            enumType: sqlanvil.TableType.TABLE,
            actionDescriptor: { columns: [{ path: ["b"], description: "bee" }, { path: ["a"] }] },
          },
          {
            target: { schema: "s", name: "alpha" },
            enumType: sqlanvil.TableType.TABLE,
            actionDescriptor: { columns: [{ path: ["z"], description: "zed" }] },
          },
        ],
        operations: [] as any[],
        assertions: [] as any[],
        exports: [] as any[],
        declarations: [] as any[],
      };
      await write(graph, P);
      const model = await build(views(P, false), GENERATED_AT);
      expectFields(model, {
        columns: [
          { readable: "s.alpha", column: "z", description: "zed" },
          { readable: "s.zeta", column: "a", description: "" },
          { readable: "s.zeta", column: "b", description: "bee" },
        ],
      }, "model");
    });
  });

  test("@prd T-021.7 two targets that read as one name keep their own status and dependsOn", async () => {
    await withTmpDir(async (P) => {
      // The graph and run result of T-021.7: database a, schema b, name c and schema a.b, name c
      // both read as a.b.c; every list the case does not name is empty.
      const graph = {
        tables: [
          {
            target: { database: "a", schema: "b", name: "c" },
            enumType: sqlanvil.TableType.TABLE,
            dependencyTargets: [{ schema: "s", name: "x" }],
          },
          { target: { schema: "a.b", name: "c" }, enumType: sqlanvil.TableType.VIEW },
        ],
        operations: [] as any[],
        assertions: [] as any[],
        exports: [] as any[],
        declarations: [] as any[],
      };
      const runResult: any = {
        status: sqlanvil.RunResult.ExecutionStatus.FAILED,
        actions: [
          {
            target: { database: "a", schema: "b", name: "c" },
            status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
            timing: { startTimeMillis: 1, endTimeMillis: 2 },
            tasks: [],
          },
          {
            target: { schema: "a.b", name: "c" },
            status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
            timing: { startTimeMillis: 2, endTimeMillis: 3 },
            tasks: [{ errorMessage: "e" }],
          },
        ],
      };
      await write(graph, P, { runResult, runId: 10 });
      // The four views of T-021.1, over P.
      const model = await build(views(P, true), GENERATED_AT);
      // Ordered by type, then readable name (AC-021.1): the table, then the view.
      expectFields(model, {
        models: [
          {
            readable: "a.b.c",
            type: "table",
            tags: [],
            description: "",
            status: "SUCCESSFUL",
            dependsOn: ["s.x"],
          },
          {
            readable: "a.b.c",
            type: "view",
            tags: [],
            description: "",
            status: "FAILED",
            dependsOn: [],
          },
        ],
      }, "model");
    });
  });

  test("@prd T-021.8 a latest run with no action results gives no model a status", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      await write(g1(), P, { runResult: successfulEmptyRun(), runId: 200 });
      // The four views of T-021.1, over P.
      const model = await build(views(P, true), GENERATED_AT);
      expectFields(model, { latestRun: { runId: 200, status: "SUCCESSFUL" } }, "model");
      expectFields(byReadable(model, "s.v"), { status: ABSENT }, "s.v");
      expectFields(byReadable(model, "s.src"), { status: ABSENT }, "s.src");
      expectFields(byReadable(model, "s.a"), { status: ABSENT }, "s.a");
    });
  });
});
