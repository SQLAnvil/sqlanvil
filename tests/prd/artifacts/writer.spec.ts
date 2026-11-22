// The artifact writer: FR-001 to FR-008 of docs/prd/sqlanvil/features/artifacts.md.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { safeWriteArtifacts, writeArtifacts } from "sa/cli/api/commands/artifacts";
import { queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { emptyGraph, g1, r1, successfulEmptyRun } from "sa/tests/prd/artifacts/fixtures";
import {
  expectKnownFailure,
  isParserErrorAfterQuote,
  knownFailure,
} from "sa/tests/prd/artifacts/known_failing";
import {
  captureOutput,
  catalogViews,
  expectFields,
  filesUnder,
  readBack,
  sortedEntries,
  withTmpDir,
  withTmpDirs,
  withTmpdirEnv,
} from "sa/tests/prd/artifacts/helpers";

const write: any = writeArtifacts;
const safeWrite: any = safeWriteArtifacts;
const query: (sql: string, views: Array<{ name: string; glob: string }>) => Promise<any[]> =
  queryParquet as any;

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

function names(rows: any[]): string[] {
  return rows.map((row) => row.name);
}

suite("prd artifacts: writer", () => {
  test("@prd T-001.1 writes the three catalog files and resolves targetDir", async () => {
    await withTmpDir(async (P) => {
      expect(fs.existsSync(path.join(P, "target"))).to.equal(false);
      const result = await write(g1(), P);
      expect(result.targetDir).to.equal(path.join(P, "target"));
      expect(fs.existsSync(path.join(P, "target/catalog/actions.parquet"))).to.equal(true);
      expect(fs.existsSync(path.join(P, "target/catalog/dependencies.parquet"))).to.equal(true);
      expect(fs.existsSync(path.join(P, "target/catalog/columns.parquet"))).to.equal(true);
    });
  });

  test("@prd T-001.2 writes each catalog file with its column list in order", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const pragma = (view: string) =>
        `select name from pragma_table_info('${view}') order by cid`;
      expect(names(await readBack(P, pragma("actions")))).to.deep.equal(ACTIONS_COLUMNS);
      expect(names(await readBack(P, pragma("dependencies")))).to.deep.equal(DEPENDENCIES_COLUMNS);
      expect(names(await readBack(P, pragma("columns")))).to.deep.equal(COLUMNS_COLUMNS);
    });
  });

  test("@prd T-001.3 a second write replaces the catalog with the new graph's rows", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      await write(
        {
          tables: [{ target: { schema: "s", name: "only" }, enumType: sqlanvil.TableType.TABLE }],
          operations: [],
          assertions: [],
          exports: [],
          declarations: [],
        },
        P,
      );
      expectFields(await readBack(P, "select readable_name from actions"), [
        { readable_name: "s.only" },
      ]);
      expect(sortedEntries(path.join(P, "target/catalog"))).to.deep.equal([
        "actions.parquet",
        "columns.parquet",
        "dependencies.parquet",
      ]);
    });
  });

  test("@prd T-001.4 known-failing E-006 writes the artifacts under a path holding a single quote", async () => {
    // Q: a new empty temporary directory whose name contains a single quote (o'brien-…).
    await withTmpDir(async (Q) => {
      expect(path.basename(Q), "precondition: Q's name holds a single quote").to.contain("'");
      expect(sortedEntries(Q), "precondition: Q is empty").to.deep.equal([]);
      await expectKnownFailure("E-006", async () => {
        let result: any;
        try {
          result = await write(g1(), Q, { runResult: r1(), runId: 123 });
        } catch (e) {
          if (isParserErrorAfterQuote(e, path.basename(Q))) {
            knownFailure(
              'writeArtifacts rejects with `Parser Error: syntax error at or near "<token>"`, where <token> is the start of the text after the single quote in the directory name',
              e instanceof Error ? e.message : String(e),
            );
          }
          throw e;
        }
        expect(result.targetDir).to.equal(path.join(Q, "target"));
        expect(sortedEntries(path.join(Q, "target/catalog"))).to.include.members([
          "actions.parquet",
          "dependencies.parquet",
          "columns.parquet",
        ]);
        expect(sortedEntries(path.join(Q, "target/runs"))).to.include("run_123.parquet");
      });
    }, "o'brien-");
  });

  test("@prd T-002.1 writes one actions row per action of every kind", async () => {
    await withTmpDir(async (P) => {
      await write(
        {
          tables: [
            { target: { schema: "s", name: "t1" }, enumType: sqlanvil.TableType.TABLE },
            { target: { schema: "s", name: "t2" }, enumType: sqlanvil.TableType.VIEW },
          ],
          operations: [{ target: { schema: "s", name: "op" } }],
          assertions: [{ target: { schema: "s", name: "as" } }],
          exports: [{ target: { schema: "s", name: "ex" } }],
          imports: [{ target: { schema: "s", name: "im" } }],
          scripts: [{ target: { schema: "s", name: "sc" } }],
          declarations: [{ target: { schema: "s", name: "dc" } }],
        },
        P,
      );
      expectFields(await readBack(P, "select name from actions order by name"), [
        { name: "as" },
        { name: "dc" },
        { name: "ex" },
        { name: "im" },
        { name: "op" },
        { name: "sc" },
        { name: "t1" },
        { name: "t2" },
      ]);
    });
  });

  test("@prd T-002.2 sets each action row's type", async () => {
    await withTmpDir(async (P) => {
      await write(
        {
          tables: [
            { target: { schema: "s", name: "t_table" }, enumType: sqlanvil.TableType.TABLE },
            { target: { schema: "s", name: "t_view" }, enumType: sqlanvil.TableType.VIEW },
            { target: { schema: "s", name: "t_incr" }, enumType: sqlanvil.TableType.INCREMENTAL },
            { target: { schema: "s", name: "t_untyped" } },
          ],
          operations: [{ target: { schema: "s", name: "x_op" } }],
          assertions: [{ target: { schema: "s", name: "x_as" } }],
          exports: [{ target: { schema: "s", name: "x_ex" } }],
          imports: [{ target: { schema: "s", name: "x_im" } }],
          scripts: [{ target: { schema: "s", name: "x_sc" } }],
          declarations: [{ target: { schema: "s", name: "x_dc" } }],
        },
        P,
      );
      expectFields(await readBack(P, "select name, type from actions order by name"), [
        { name: "t_incr", type: "incremental" },
        { name: "t_table", type: "table" },
        { name: "t_untyped", type: "table" },
        { name: "t_view", type: "view" },
        { name: "x_as", type: "assertion" },
        { name: "x_dc", type: "declaration" },
        { name: "x_ex", type: "export" },
        { name: "x_im", type: "import" },
        { name: "x_op", type: "operation" },
        { name: "x_sc", type: "script" },
      ]);
    });
  });

  test("@prd T-002.3 sets target_key, readable_name and the target parts", async () => {
    await withTmpDir(async (P) => {
      await write(
        {
          tables: [
            { target: { database: "d", schema: "s", name: "t" }, enumType: sqlanvil.TableType.TABLE },
            { target: { schema: "s", name: "u" }, enumType: sqlanvil.TableType.TABLE },
          ],
          operations: [],
          assertions: [],
          exports: [],
          declarations: [],
        },
        P,
      );
      expectFields(
        await readBack(
          P,
          "select target_key, database, schema, name, readable_name from actions order by name",
        ),
        [
          {
            target_key: '{"database":"d","name":"t","schema":"s"}',
            database: "d",
            schema: "s",
            name: "t",
            readable_name: "d.s.t",
          },
          {
            target_key: '{"name":"u","schema":"s"}',
            database: "",
            schema: "s",
            name: "u",
            readable_name: "s.u",
          },
        ],
      );
    });
  });

  test("@prd T-002.4 sets tags, disabled, file_name and description", async () => {
    await withTmpDir(async (P) => {
      await write(
        {
          tables: [
            {
              target: { schema: "s", name: "t" },
              enumType: sqlanvil.TableType.TABLE,
              tags: ["a", "b"],
              disabled: true,
              fileName: "definitions/t.sqlx",
              actionDescriptor: { description: "the t table" },
            },
          ],
          operations: [],
          assertions: [],
          exports: [],
          declarations: [],
        },
        P,
      );
      expectFields(
        await readBack(P, "select tags, disabled, file_name, description from actions"),
        [{ tags: '["a","b"]', disabled: true, file_name: "definitions/t.sqlx", description: "the t table" }],
      );
    });
  });

  test("@prd T-002.5 writes [], empty strings and false for missing action fields", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      expectFields(
        await readBack(
          P,
          "select database, tags, disabled, file_name, description from actions where name = 'a'",
        ),
        [{ database: "", tags: "[]", disabled: false, file_name: "", description: "" }],
      );
    });
  });

  test("@prd T-003.1 writes one dependencies row per dependency target", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      expectFields(await readBack(P, "select * from dependencies order by from_readable"), [
        {
          from_target_key: '{"name":"a","schema":"s"}',
          to_target_key: '{"name":"v","schema":"s"}',
          from_readable: "s.a",
          to_readable: "s.v",
        },
        {
          from_target_key: '{"name":"v","schema":"s"}',
          to_target_key: '{"name":"src","schema":"s"}',
          from_readable: "s.v",
          to_readable: "s.src",
        },
      ]);
    });
  });

  test("@prd T-003.2 writes no dependencies row from an action with no dependencies", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      expectFields(
        await readBack(P, "select count(*) as n from dependencies where from_readable = 's.src'"),
        [{ n: 0 }],
      );
    });
  });

  test("@prd T-004.1 writes one columns row per descriptor column", async () => {
    await withTmpDir(async (P) => {
      await write(
        {
          tables: [
            {
              target: { schema: "s", name: "t" },
              enumType: sqlanvil.TableType.TABLE,
              actionDescriptor: {
                columns: [{ path: ["id"], description: "the id" }, { path: ["address", "city"] }],
              },
            },
          ],
          operations: [],
          assertions: [],
          exports: [],
          declarations: [],
        },
        P,
      );
      expectFields(await readBack(P, "select * from columns order by column_name"), [
        {
          target_key: '{"name":"t","schema":"s"}',
          readable_name: "s.t",
          column_name: "address.city",
          description: "",
        },
        {
          target_key: '{"name":"t","schema":"s"}',
          readable_name: "s.t",
          column_name: "id",
          description: "the id",
        },
      ]);
    });
  });

  test("@prd T-004.2 writes no columns row for an action with no descriptor columns", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      expectFields(
        await readBack(
          P,
          "select count(*) as n from columns where readable_name in ('s.v', 's.a')",
        ),
        [{ n: 0 }],
      );
    });
  });

  test("@prd T-005.1 writes run_<run id>.parquet with one row per action result", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      expectFields(await readBack(P, "select * from runs order by readable_name"), [
        {
          run_id: 123,
          run_status: "FAILED",
          target_key: '{"name":"src","schema":"s"}',
          readable_name: "s.src",
          status: "SUCCESSFUL",
          start_millis: 1000,
          end_millis: 1400,
          duration_millis: 400,
          error_message: "",
        },
        {
          run_id: 123,
          run_status: "FAILED",
          target_key: '{"name":"v","schema":"s"}',
          readable_name: "s.v",
          status: "FAILED",
          start_millis: 1400,
          end_millis: 1600,
          duration_millis: 200,
          error_message: "boom",
        },
      ]);
      expect(sortedEntries(path.join(P, "target/runs"))).to.deep.equal(["run_123.parquet"]);
    });
  });

  test("@prd T-005.2 uses the current epoch milliseconds when no run id is given", async () => {
    await withTmpDir(async (P) => {
      const t0 = Date.now();
      await write(g1(), P, { runResult: r1() });
      const t1 = Date.now();
      const files = sortedEntries(path.join(P, "target/runs"));
      expect(files.length).to.equal(1);
      const match = /^run_(\d+)\.parquet$/.exec(files[0]);
      expect(match, `file name ${files[0]}`).to.not.equal(null);
      const n = Number(match![1]);
      expect(n).to.be.at.least(t0);
      expect(n).to.be.at.most(t1);
      expectFields(await readBack(P, "select distinct run_id from runs"), [{ run_id: n }]);
    });
  });

  test("@prd T-005.3 sets run_status and status to the execution status names", async () => {
    await withTmpDir(async (P) => {
      const runResult = {
        status: sqlanvil.RunResult.ExecutionStatus.TIMED_OUT,
        actions: [
          {
            target: { schema: "s", name: "src" },
            status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
            timing: { startTimeMillis: 10, endTimeMillis: 20 },
            tasks: [] as any[],
          },
          {
            target: { schema: "s", name: "v" },
            status: sqlanvil.ActionResult.ExecutionStatus.CANCELLED,
            timing: { startTimeMillis: 10, endTimeMillis: 20 },
            tasks: [] as any[],
          },
        ],
      };
      await write(g1(), P, { runResult, runId: 7 });
      expectFields(
        await readBack(P, "select run_status, readable_name, status from runs order by readable_name"),
        [
          { run_status: "TIMED_OUT", readable_name: "s.src", status: "SKIPPED" },
          { run_status: "TIMED_OUT", readable_name: "s.v", status: "CANCELLED" },
        ],
      );
    });
  });

  test("@prd T-005.4 writes UNKNOWN for a missing status", async () => {
    await withTmpDir(async (P) => {
      const runResult = {
        actions: [
          {
            target: { schema: "s", name: "src" },
            timing: { startTimeMillis: 10, endTimeMillis: 20 },
            tasks: [] as any[],
          },
        ],
      };
      await write(g1(), P, { runResult, runId: 8 });
      expectFields(await readBack(P, "select run_status, status from runs"), [
        { run_status: "UNKNOWN", status: "UNKNOWN" },
      ]);
    });
  });

  test("@prd T-005.5 takes the times from Long timing and 0 when timing is absent", async () => {
    await withTmpDir(async (P) => {
      const timing = (sqlanvil.ActionResult.fromObject({
        timing: { startTimeMillis: "1000", endTimeMillis: "1500" },
      }) as any).timing;
      expect(typeof timing.startTimeMillis, "precondition: the timing holds protobufjs Long values").to.not.equal("number");
      expect(typeof timing.endTimeMillis, "precondition: the timing holds protobufjs Long values").to.not.equal("number");
      const runResult = {
        status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
        actions: [
          {
            target: { schema: "s", name: "src" },
            status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
            timing,
            tasks: [] as any[],
          },
          {
            target: { schema: "s", name: "v" },
            status: sqlanvil.ActionResult.ExecutionStatus.DISABLED,
            tasks: [] as any[],
          },
        ],
      };
      await write(g1(), P, { runResult, runId: 9 });
      expectFields(
        await readBack(
          P,
          "select readable_name, start_millis, end_millis, duration_millis from runs order by readable_name",
        ),
        [
          { readable_name: "s.src", start_millis: 1000, end_millis: 1500, duration_millis: 500 },
          { readable_name: "s.v", start_millis: 0, end_millis: 0, duration_millis: 0 },
        ],
      );
    });
  });

  test("@prd T-005.6 takes error_message from the first task that has one", async () => {
    await withTmpDir(async (P) => {
      const runResult = {
        status: sqlanvil.RunResult.ExecutionStatus.FAILED,
        actions: [
          {
            target: { schema: "s", name: "src" },
            status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
            timing: { startTimeMillis: 1, endTimeMillis: 2 },
            tasks: [{}, { errorMessage: "first" }, { errorMessage: "second" }],
          },
          {
            target: { schema: "s", name: "v" },
            status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
            timing: { startTimeMillis: 1, endTimeMillis: 2 },
            tasks: [{}],
          },
        ],
      };
      await write(g1(), P, { runResult, runId: 10 });
      expectFields(
        await readBack(P, "select readable_name, error_message from runs order by readable_name"),
        [
          { readable_name: "s.src", error_message: "first" },
          { readable_name: "s.v", error_message: "" },
        ],
      );
    });
  });

  test("@prd T-005.7 writes nothing under target/runs without a run result", async () => {
    await withTmpDir(async (P) => {
      const result = await write(g1(), P);
      expect(result.targetDir).to.equal(path.join(P, "target"));
      expect(fs.existsSync(path.join(P, "target/runs"))).to.equal(false);
    });
  });

  test("@prd T-005.8 leaves the other run files unchanged", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 1 });
      const before = fs.readFileSync(path.join(P, "target/runs/run_1.parquet"));
      await write(g1(), P, { runResult: r1(), runId: 2 });
      const after = fs.readFileSync(path.join(P, "target/runs/run_1.parquet"));
      expect(after.equals(before), "run_1.parquet's bytes are unchanged").to.equal(true);
      expect(sortedEntries(path.join(P, "target/runs"))).to.deep.equal([
        "run_1.parquet",
        "run_2.parquet",
      ]);
      expectFields(
        await readBack(P, "select run_id, count(*) as n from runs group by run_id order by run_id"),
        [
          { run_id: 1, n: 2 },
          { run_id: 2, n: 2 },
        ],
      );
    });
  });

  test("@prd T-005.9 known-failing E-002 records the run id and status of a run with no action results", async () => {
    await withTmpDir(async (P) => {
      await expectKnownFailure("E-002", async () => {
        await write(g1(), P, { runResult: successfulEmptyRun(), runId: 300 });
        const rows = await readBack(
          P,
          "select distinct run_id, run_status from runs where run_id = 300",
        );
        if (Array.isArray(rows) && rows.length === 0) {
          knownFailure("the runs view holds no row for run 300", "0 rows");
        }
        expectFields(rows, [{ run_id: 300, run_status: "SUCCESSFUL" }]);
      });
    });
  });

  test("@prd T-005.10 keeps every run-history file", async () => {
    await withTmpDir(async (P) => {
      for (const options of [
        { runResult: r1(), runId: 1 },
        { runResult: r1(), runId: 2 },
        { runResult: r1(), runId: 3 },
        undefined,
      ]) {
        const result = options ? await write(g1(), P, options) : await write(g1(), P);
        expect(result.targetDir).to.equal(path.join(P, "target"));
      }
      expect(sortedEntries(path.join(P, "target/runs"))).to.deep.equal([
        "run_1.parquet",
        "run_2.parquet",
        "run_3.parquet",
      ]);
    });
  });

  test("@prd T-006.1 known-failing E-003 an empty rowset keeps its file's column names and types", async () => {
    await withTmpDirs(2, async (P, P2) => {
      await expectKnownFailure("E-003", async () => {
        await write(emptyGraph(), P);
        await write(g1(), P2);
        const viewsP = catalogViews(P);
        const viewsP2 = catalogViews(P2);
        const expectedColumns: { [view: string]: string[] } = {
          actions: ACTIONS_COLUMNS,
          dependencies: DEPENDENCIES_COLUMNS,
          columns: COLUMNS_COLUMNS,
        };
        // Reads 1 to 3: the count and the column names of each file over P.
        for (const view of ["actions", "dependencies", "columns"]) {
          expectFields(await query(`select count(*) as n from ${view}`, viewsP), [{ n: 0 }]);
          expect(
            names(await query(`select name from pragma_table_info('${view}') order by cid`, viewsP)),
            `${view} columns`,
          ).to.deep.equal(expectedColumns[view]);
        }
        // Read 4: the (name, type) list of each file over P against the one over P2.
        const typesSql = (view: string) =>
          `select name, type from pragma_table_info('${view}') order by cid`;
        for (const view of ["actions", "dependencies", "columns"]) {
          const overP = (await query(typesSql(view), viewsP)).map((r: any) => ({ name: r.name, type: r.type }));
          const overP2 = (await query(typesSql(view), viewsP2)).map((r: any) => ({ name: r.name, type: r.type }));
          if (
            view === "actions" &&
            overP.length > 0 &&
            overP.every((r: any) => String(r.type) === "JSON") &&
            overP2.length > 0 &&
            overP2.every((r: any) => String(r.type) === (r.name === "disabled" ? "BOOLEAN" : "VARCHAR"))
          ) {
            knownFailure(
              "every column of the empty actions file over P has type JSON, where the actions file over P2 has VARCHAR, and BOOLEAN for disabled",
              `over P ${JSON.stringify(overP)}; over P2 ${JSON.stringify(overP2)}`,
            );
          }
          expect(overP, `${view} (name, type) over P equals the one over P2`).to.deep.equal(overP2);
        }
      });
    });
  });

  test("@prd T-007.1 leaves no sa_artifact_ staging file after a successful write", async () => {
    await withTmpDirs(2, async (P, D) => {
      const result: any = await withTmpdirEnv(D, () =>
        write(g1(), P, { runResult: r1(), runId: 5 }),
      );
      expect(result.targetDir).to.equal(path.join(P, "target"));
      expect(filesUnder(D).filter((f) => path.basename(f).startsWith("sa_artifact_"))).to.deep.equal(
        [],
      );
    });
  });

  test("@prd T-007.2 removes the staging file when the COPY fails", async () => {
    await withTmpDirs(2, async (P, D) => {
      fs.mkdirSync(path.join(P, "target/catalog/actions.parquet"), { recursive: true });
      let rejected = false;
      await withTmpdirEnv(D, async () => {
        try {
          await write(g1(), P);
        } catch (e) {
          rejected = true;
        }
      });
      expect(rejected, "the call rejects").to.equal(true);
      expect(filesUnder(D).filter((f) => path.basename(f).startsWith("sa_artifact_"))).to.deep.equal(
        [],
      );
    });
  });

  test("@prd T-008.1 safeWriteArtifacts warns once and resolves when the write fails", async () => {
    await withTmpDir(async (P) => {
      fs.writeFileSync(path.join(P, "target"), "a regular file");
      const warnings: string[] = [];
      const value = await safeWrite(g1(), P, { warn: (message: string) => warnings.push(message) });
      expect(value).to.equal(undefined);
      expect(warnings.length).to.equal(1);
      expect(warnings[0].startsWith("Artifacts skipped: "), warnings[0]).to.equal(true);
      expect(fs.statSync(path.join(P, "target")).isFile()).to.equal(true);
      expect(fs.readFileSync(path.join(P, "target"), "utf8")).to.equal("a regular file");
    });
  });

  test("@prd T-008.2 safeWriteArtifacts without warn resolves and writes no output", async () => {
    await withTmpDir(async (P) => {
      fs.writeFileSync(path.join(P, "target"), "a regular file");
      const { value, written } = await captureOutput(() => safeWrite(g1(), P));
      expect(value).to.equal(undefined);
      expect(written).to.equal("");
    });
  });
});
