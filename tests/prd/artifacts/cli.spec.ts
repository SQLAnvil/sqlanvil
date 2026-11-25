// The artifact commands: FR-009 to FR-016 and FR-018 to FR-020 of
// docs/prd/sqlanvil/features/artifacts.md, run through the bundled CLI.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { writeArtifacts } from "sa/cli/api/commands/artifacts";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { g1, r1, runWithSkipped, successfulEmptyRun } from "sa/tests/prd/artifacts/fixtures";
import {
  cliEnv,
  entriesUnder,
  expectFields,
  lines,
  runCli,
  snapshot,
  withTmpDir,
  withTmpDirs,
} from "sa/tests/prd/artifacts/helpers";
import {
  expectKnownFailure,
  isParserErrorAfterQuote,
  knownFailure,
} from "sa/tests/prd/artifacts/known_failing";

const write: any = writeArtifacts;

const NOT_FOUND = "No artifacts found under target/. Run `sqlanvil compile` (or `run`) first.";
const SQL_REQUIRED = 'Provide a SQL query, e.g. sqlanvil query "select * from actions".';
const ACTIONS_BY_TYPE = [
  "Actions by type:",
  "type       n",
  "---------  -",
  "assertion  1",
  "table      1",
  "view       1",
  "",
  "(3 rows)",
];
const ACTIONS_BY_TYPE_JSON = [
  { type: "assertion", n: 1 },
  { type: "table", n: 1 },
  { type: "view", n: 1 },
];

function json(stdout: string): any {
  return JSON.parse(stdout);
}

suite("prd artifacts: commands", () => {
  test("@prd T-009.1 query refuses a project with no catalog", async () => {
    await withTmpDir(async (P) => {
      const r = await runCli(["query", "select 1", P]);
      expect(r.exitCode).to.equal(1);
      expect(lines(r.stderr)).to.deep.equal([NOT_FOUND]);
      expect(r.stdout).to.equal("");
    });
  });

  test("@prd T-009.2 inspect refuses a project with runs but no catalog", async () => {
    await withTmpDirs(2, async (P, Q) => {
      await write(g1(), Q, { runResult: r1(), runId: 1 });
      fs.mkdirSync(path.join(P, "target/runs"), { recursive: true });
      fs.copyFileSync(
        path.join(Q, "target/runs/run_1.parquet"),
        path.join(P, "target/runs/run_1.parquet"),
      );
      expect(fs.existsSync(path.join(P, "target/catalog"))).to.equal(false);
      const r = await runCli(["inspect", P]);
      expect(r.exitCode).to.equal(1);
      expect(lines(r.stderr)).to.deep.equal([NOT_FOUND]);
      expect(r.stdout).to.equal("");
    });
  });

  test("@prd T-009.3 docs refuses a project with no catalog and writes no page", async () => {
    await withTmpDir(async (P) => {
      const r = await runCli(["docs", P]);
      expect(r.exitCode).to.equal(1);
      expect(lines(r.stderr)).to.deep.equal([NOT_FOUND]);
      expect(r.stdout).to.equal("");
      expect(fs.existsSync(path.join(P, "target/docs/index.html"))).to.equal(false);
    });
  });

  test("@prd T-009.4 inspect with no project-dir reads the current directory", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["inspect"], { cwd: P });
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout)).to.deep.equal([...ACTIONS_BY_TYPE, "", "No runs recorded yet."]);
    });
  });

  test("@prd T-010.1 exposes actions, dependencies and columns as views", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli([
        "query",
        "select (select count(*) from actions) as a, (select count(*) from dependencies) as d, (select count(*) from columns) as c",
        P,
        "--json",
      ]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [{ a: 3, d: 2, c: 1 }]);
    });
  });

  test("@prd T-010.2 exposes every run file together as the runs view", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 100 });
      await write(g1(), P, {
        runResult: {
          status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
          actions: [
            {
              target: { schema: "s", name: "src" },
              status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
              timing: { startTimeMillis: 1, endTimeMillis: 2 },
              tasks: [],
            },
          ],
        },
        runId: 200,
      });
      const r = await runCli([
        "query",
        "select run_id, count(*) as n from runs group by run_id order by run_id",
        P,
        "--json",
      ]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [
        { run_id: 100, n: 2 },
        { run_id: 200, n: 1 },
      ]);
    });
  });

  test("@prd T-010.3 creates no runs view when target/runs holds no parquet file", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      fs.mkdirSync(path.join(P, "target/runs"), { recursive: true });
      fs.writeFileSync(path.join(P, "target/runs/notes.txt"), "notes");
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: null,
        failures: [],
      });
    });
  });

  test("@prd T-010.4 query runs over actions when dependencies and columns are missing", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      fs.unlinkSync(path.join(P, "target/catalog/dependencies.parquet"));
      fs.unlinkSync(path.join(P, "target/catalog/columns.parquet"));
      const r = await runCli(["query", "select count(*) as n from actions", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [{ n: 3 }]);
    });
  });

  test("@prd T-010.5 known-failing E-006 query reads a project whose path holds a single quote", async () => {
    // Q: a temporary directory whose name contains a single quote (o'brien-…).
    await withTmpDir(async (Q) => {
      expect(path.basename(Q), "precondition: Q's name holds a single quote").to.contain("'");
      await expectKnownFailure("E-006", async () => {
        // Setup: target/ written by writeArtifacts(G1, Q).
        try {
          await write(g1(), Q);
        } catch (e) {
          if (isParserErrorAfterQuote(e, path.basename(Q))) {
            knownFailure(
              'writing the project\'s artifacts rejects with `Parser Error: syntax error at or near "<token>"`, where <token> is the start of the text after the single quote in the directory name, so the query does not run',
              e instanceof Error ? e.message : String(e),
            );
          }
          throw e;
        }
        const r = await runCli(["query", "select count(*) as n from actions", Q, "--json"]);
        expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
        expectFields(json(r.stdout), [{ n: 3 }]);
      });
    }, "o'brien-");
  });

  test("@prd T-010.6 exposes every run-summary file together as the run_summary view", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 100 });
      await write(g1(), P, {
        runResult: {
          status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
          actions: [
            {
              target: { schema: "s", name: "src" },
              status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
              timing: { startTimeMillis: 1, endTimeMillis: 2 },
              tasks: [],
            },
          ],
        },
        runId: 200,
      });
      const r = await runCli([
        "query",
        "select run_id, run_status from run_summary order by run_id",
        P,
        "--json",
      ]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expectFields(json(r.stdout), [
        { run_id: 100, run_status: "FAILED" },
        { run_id: 200, run_status: "SUCCESSFUL" },
      ]);
    });
  });

  test("@prd T-010.7 creates no run_summary view when target/run_summary holds no parquet file", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      // Every file under P/target/run_summary removed, then P/target/run_summary/notes.txt added.
      const summaryDir = path.join(P, "target/run_summary");
      for (const entry of fs.readdirSync(summaryDir)) {
        fs.rmSync(path.join(summaryDir, entry), { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(summaryDir, "notes.txt"), "notes");
      expect(fs.readdirSync(summaryDir), "precondition: no .parquet file").to.deep.equal([
        "notes.txt",
      ]);
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: { run_id: 123, run_status: "FAILED", succeeded: 1, failed: 1, wall_ms: 600 },
        failures: [{ readable_name: "s.v", error_message: "boom" }],
      });
    });
  });

  test("@prd T-011.1 query prints a padded table and leaves target unchanged", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const before = snapshot(path.join(P, "target"));
      const r = await runCli(["query", "select name, type from actions order by name", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout)).to.deep.equal([
        "name  type     ",
        "----  ---------",
        "a     assertion",
        "src   table    ",
        "v     view     ",
        "",
        "(3 rows)",
      ]);
      expect(r.stderr).to.equal("");
      expect(snapshot(path.join(P, "target"))).to.deep.equal(before);
    });
  });

  test("@prd T-011.2 query prints (0 rows) alone for no rows", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "select * from actions where false", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout)).to.deep.equal(["(0 rows)"]);
    });
  });

  test("@prd T-011.3 query prints a null as an empty string", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "select null as x, 'y' as y", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout)).to.deep.equal(["x  y", "-  -", "   y", "", "(1 row)"]);
    });
  });

  test("@prd T-011.4 query reports SQL that DuckDB rejects", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "select * from no_such_view", P]);
      expect(r.exitCode).to.equal(1);
      expect(r.stderr).to.contain("no_such_view");
      expect(r.stdout).to.equal("");
    });
  });

  test("@prd T-012.1 query --json prints the rows as an indented JSON array", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "select name, type from actions order by name", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [
        { name: "a", type: "assertion" },
        { name: "src", type: "table" },
        { name: "v", type: "view" },
      ]);
      const nested = lines(r.stdout.trim()).slice(1, -1);
      expect(nested.length).to.be.greaterThan(0);
      for (const line of nested) {
        const indent = line.length - line.trimStart().length;
        expect(indent > 0 && indent % 4 === 0, `indent of ${JSON.stringify(line)}`).to.equal(true);
      }
    });
  });

  test("@prd T-013.1 query with no sql argument fails", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query"], { cwd: P });
      expect(r.exitCode).to.equal(1);
      expect(r.stderr).to.contain(SQL_REQUIRED);
      expect(r.stdout).to.equal("");
    });
  });

  test("@prd T-013.2 query with an empty sql argument fails", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "", P]);
      expect(r.exitCode).to.equal(1);
      expect(r.stderr).to.contain(SQL_REQUIRED);
      expect(r.stdout).to.equal("");
    });
  });

  test("@prd T-013.3 query with one positional takes it as SQL over the current directory", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["query", "select count(*) as n from actions", "--json"], { cwd: P });
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [{ n: 3 }]);
    });
  });

  test("@prd T-014.1 returns safe 64-bit integers as JSON numbers", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli([
        "query",
        "select count(*) as n, 9007199254740991::BIGINT as hi, -9007199254740991::BIGINT as lo from actions",
        P,
        "--json",
      ]);
      expect(r.exitCode).to.equal(0);
      const rows = json(r.stdout);
      expectFields(rows, [{ n: 3, hi: 9007199254740991, lo: -9007199254740991 }]);
      expect(typeof rows[0].n).to.equal("number");
      expect(typeof rows[0].hi).to.equal("number");
      expect(typeof rows[0].lo).to.equal("number");
    });
  });

  test("@prd T-014.2 returns unsafe 64-bit integers as decimal strings", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli([
        "query",
        "select 9007199254740993::BIGINT as big, -9007199254740993::BIGINT as neg",
        P,
        "--json",
      ]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [{ big: "9007199254740993", neg: "-9007199254740993" }]);
    });
  });

  test("@prd T-015.1 each query runs in a fresh in-memory DuckDB", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const before = entriesUnder(P);
      const first = await runCli(["query", "create table t as select 1 as x", P]);
      expect(first.exitCode).to.equal(0);
      const second = await runCli([
        "query",
        "select count(*) as n from duckdb_tables() where table_name = 't'",
        P,
        "--json",
      ]);
      expect(second.exitCode).to.equal(0);
      expectFields(json(second.stdout), [{ n: 0 }]);
      const gained = entriesUnder(P).filter((entry) => !before.includes(entry));
      expect(gained, "new files or directories under P and P/target").to.deep.equal([]);
    });
  });

  test("@prd T-015.2 query runs SQL that writes a file", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const out = path.join(P, "out.csv");
      const r = await runCli(["query", `copy (select 1 as x) to '${out}' (header)`, P]);
      expect(r.exitCode).to.equal(0);
      expect(fs.existsSync(out)).to.equal(true);
      expect(lines(fs.readFileSync(out, "utf8"))).to.deep.equal(["x", "1"]);
    });
  });

  test("@prd T-016.1 sets DuckDB's home_directory to TMPDIR when HOME is unset", async () => {
    await withTmpDirs(2, async (P, D) => {
      await write(g1(), P);
      const dir = D.replace(/\/+$/, "");
      const r = await runCli(
        ["query", "select current_setting('home_directory') as h", P, "--json"],
        { env: cliEnv({ TMPDIR: dir, HOME: undefined }) },
      );
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), [{ h: dir }]);
    });
  });

  test("@prd T-018.1 inspect prints the actions by type", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const r = await runCli(["inspect", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout).slice(0, ACTIONS_BY_TYPE.length)).to.deep.equal(ACTIONS_BY_TYPE);
    });
  });

  test("@prd T-018.2 inspect prints the latest run line", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const r = await runCli(["inspect", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout).slice(8, 10)).to.deep.equal([
        "",
        "Latest run (FAILED): 1 succeeded, 1 failed, 600ms",
      ]);
    });
  });

  test("@prd T-018.3 inspect lists the first 20 failures in readable_name order", async () => {
    await withTmpDirs(2, async (P, Q) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const first = await runCli(["inspect", P]);
      expect(first.exitCode).to.equal(0);
      const firstLines = lines(first.stdout);
      expect(firstLines.slice(-7)).to.deep.equal([
        "",
        "Failures:",
        "readable_name  error_message",
        "-------------  -------------",
        "s.v            boom         ",
        "",
        "(1 row)",
      ]);

      const tableNames: string[] = [];
      for (let i = 1; i <= 21; i++) {
        tableNames.push(`f${String(i).padStart(2, "0")}`);
      }
      const g21 = {
        tables: tableNames.map((name) => ({ target: { schema: "s", name } })),
        operations: [] as any[],
        assertions: [] as any[],
        exports: [] as any[],
        declarations: [] as any[],
      };
      const r21 = {
        status: sqlanvil.RunResult.ExecutionStatus.FAILED,
        actions: tableNames.map((name) => ({
          target: { schema: "s", name },
          status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
          timing: { startTimeMillis: 10, endTimeMillis: 20 },
          tasks: [{ errorMessage: "e" }],
        })),
      };
      await write(g21, Q, { runResult: r21, runId: 5 });
      const second = await runCli(["inspect", Q]);
      expect(second.exitCode).to.equal(0);
      const secondLines = lines(second.stdout);
      const at = secondLines.indexOf("Failures:");
      expect(at, "a Failures: line").to.be.at.least(0);
      const rows = tableNames
        .slice(0, 20)
        .map((name) => `${`s.${name}`.padEnd(13)}  ${"e".padEnd(13)}`);
      expect(secondLines.slice(at + 1)).to.deep.equal([
        "readable_name  error_message",
        "-------------  -------------",
        ...rows,
        "",
        "(20 rows)",
      ]);
    });
  });

  test("@prd T-018.4 inspect says no runs are recorded", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["inspect", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout)).to.deep.equal([...ACTIONS_BY_TYPE, "", "No runs recorded yet."]);
    });
  });

  test("@prd T-018.5 inspect's wall time skips rows with no timing", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: runWithSkipped(), runId: 124 });
      const r = await runCli(["inspect", P]);
      expect(r.exitCode).to.equal(0);
      expect(lines(r.stdout).slice(8, 10)).to.deep.equal([
        "",
        "Latest run (SUCCESSFUL): 1 succeeded, 0 failed, 400ms",
      ]);
    });
  });

  test("@prd T-018.6 inspect reports a latest run with no action results", async () => {
    await withTmpDir(async (P) => {
      // Setup: run 123 (R1), then run 200 with no action results.
      await write(g1(), P, { runResult: r1(), runId: 123 });
      await write(g1(), P, { runResult: successfulEmptyRun(), runId: 200 });
      const r = await runCli(["inspect", P]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expect(lines(r.stdout).slice(8, 10)).to.deep.equal([
        "",
        "Latest run (SUCCESSFUL): 0 succeeded, 0 failed, 0ms",
      ]);
    });
  });

  test("@prd T-018.8 inspect falls back to the runs view when target/run_summary is missing", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      // As in artifacts written before run-summary files existed.
      fs.rmSync(path.join(P, "target/run_summary"), { recursive: true, force: true });
      expect(fs.existsSync(path.join(P, "target/run_summary"))).to.equal(false);
      const r = await runCli(["inspect", P]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expect(lines(r.stdout).slice(8, 10)).to.deep.equal([
        "",
        "Latest run (FAILED): 1 succeeded, 1 failed, 600ms",
      ]);
    });
  });

  test("@prd T-019.1 inspect --json prints the summary of a recorded run", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: { run_id: 123, run_status: "FAILED", succeeded: 1, failed: 1, wall_ms: 600 },
        failures: [{ readable_name: "s.v", error_message: "boom" }],
      });
    });
  });

  test("@prd T-019.2 inspect --json prints null latestRun with no runs", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: null,
        failures: [],
      });
    });
  });

  test("@prd T-019.3 inspect --json wall time skips rows with no timing", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: runWithSkipped(), runId: 124 });
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: { run_id: 124, run_status: "SUCCESSFUL", succeeded: 1, failed: 0, wall_ms: 400 },
        failures: [],
      });
    });
  });

  test("@prd T-019.4 inspect --json reports a latest run with no action results", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P, { runResult: r1(), runId: 123 });
      await write(g1(), P, { runResult: successfulEmptyRun(), runId: 200 });
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expectFields(json(r.stdout), {
        actionsByType: ACTIONS_BY_TYPE_JSON,
        latestRun: { run_id: 200, run_status: "SUCCESSFUL", succeeded: 0, failed: 0, wall_ms: 0 },
        failures: [],
      });
    });
  });

  test("@prd T-020.1 docs writes target/docs/index.html", async () => {
    await withTmpDir(async (P) => {
      expect(path.isAbsolute(P)).to.equal(true);
      await write(g1(), P, { runResult: r1(), runId: 123 });
      expect(fs.existsSync(path.join(P, "target/docs"))).to.equal(false);
      const r = await runCli(["docs", P]);
      expect(r.exitCode).to.equal(0);
      const page = path.join(P, "target/docs/index.html");
      expect(lines(r.stdout)).to.deep.equal([`Wrote catalog to ${page}`]);
      expect(fs.existsSync(page)).to.equal(true);
      const html = fs.readFileSync(page, "utf8");
      expect(html).to.contain("<title>SQLAnvil catalog</title>");
      expect(html).to.contain("3 models — 1 assertion, 1 table, 1 view");
      expect(html).to.contain("Last run: <strong>FAILED</strong> (run 123)");
    });
  });

  test("@prd T-020.2 docs replaces an existing index.html", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      fs.mkdirSync(path.join(P, "target/docs"), { recursive: true });
      fs.writeFileSync(path.join(P, "target/docs/index.html"), "OLD-DOCS-PAGE-MARKER");
      const r = await runCli(["docs", P]);
      expect(r.exitCode).to.equal(0);
      const html = fs.readFileSync(path.join(P, "target/docs/index.html"), "utf8");
      expect(html).to.not.contain("OLD-DOCS-PAGE-MARKER");
      expect(html).to.contain("<title>SQLAnvil catalog</title>");
    });
  });

  test("@prd T-020.3 docs stamps the page with the time it ran", async () => {
    await withTmpDir(async (P) => {
      await write(g1(), P);
      const t0 = Date.now();
      const r = await runCli(["docs", P]);
      const t1 = Date.now();
      expect(r.exitCode).to.equal(0);
      const html = fs.readFileSync(path.join(P, "target/docs/index.html"), "utf8");
      const match = /generated (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(html);
      expect(match, "a `generated <ts>` text").to.not.equal(null);
      const ts = Date.parse(match![1]);
      expect(ts).to.be.at.least(t0);
      expect(ts).to.be.at.most(t1);
    });
  });
});
