// Characterization tests for E-007 (inspect lists an arbitrary 20 of more than 20 failures):
// T-018.7 (AC-018.3, the table) and T-019.5 (AC-019.1, --json). Written from
// docs/prd/sqlanvil/test-cases/artifacts.yaml and testing.md (Harness) only.

import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { writeArtifacts } from "sa/cli/api/commands/artifacts";
import { cliEntryPointPath } from "sa/cli/index_test_base";
import { sqlanvil } from "sa/protos/ts";
import { getProcessResult, nodePath, suite, test } from "sa/testing";

// s.f01 .. s.f21
const NAMES = Array.from({ length: 21 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`);

// G21: 21 tables s.f01 to s.f21; a table with no stated type has no enumType, and every other
// action list is empty (testing.md, Assertions).
const G21 = {
  tables: NAMES.map(name => ({ target: { schema: "s", name } })),
  assertions: [] as any[],
  operations: [] as any[],
  exports: [] as any[],
  declarations: [] as any[]
};

// R21R: status FAILED, one FAILED action result per table, listed in reverse readable_name order
// (s.f21 first, s.f01 last), each with timing {10, 20} and tasks [{errorMessage: e}].
const R21R = {
  status: sqlanvil.RunResult.ExecutionStatus.FAILED,
  actions: [...NAMES].reverse().map(name => ({
    target: { schema: "s", name },
    status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
    timing: { startTimeMillis: 10, endTimeMillis: 20 },
    tasks: [{ errorMessage: "e" }]
  }))
};

async function withProject(body: (p: string) => Promise<void>): Promise<void> {
  const p = await fs.promises.mkdtemp(path.join(os.tmpdir(), "inspect-e007-"));
  try {
    await writeArtifacts(G21 as any, p, { runResult: R21R as any, runId: 5 });
    await body(p);
  } finally {
    await fs.promises.rm(p, { recursive: true, force: true });
  }
}

async function runCli(argv: string[]) {
  return getProcessResult(
    execFile(nodePath, [cliEntryPointPath, ...argv], {
      env: { ...process.env, NO_COLOR: "1" }
    })
  );
}

// CLI stdout split as a file is: on \n, one final newline allowed, no CRLF (testing.md).
function lines(stdout: string): string[] {
  expect(stdout.includes("\r"), "stdout holds a CR").to.equal(false);
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  return text.split("\n");
}

suite("inspect with more than 20 failures (E-007)", () => {
  test("@prd T-018.7 inspect lists the first 20 failures in readable_name order", async () => {
    await withProject(async p => {
      const result = await runCli(["inspect", p]);
      const out = lines(result.stdout);
      const at = out.indexOf("Failures:");
      expect(at, "no `Failures:` line").to.be.greaterThan(-1);
      const after = out.slice(at + 1);

      expect(result.exitCode).to.equal(0);
      // AC-011.1: each value padded to its column's width (the longest of the column name and
      // its values), columns separated by two spaces, then an empty line and `(<n> rows)`.
      const width = "readable_name".length; // 13, also "error_message".length
      const expected = [
        "readable_name  error_message",
        "-------------  -------------",
        ...NAMES.slice(0, 20).map(n => `s.${n}`.padEnd(width) + "  " + "e".padEnd(width)),
        "",
        "(20 rows)"
      ];
      expect(after).to.deep.equal(expected);
    });
  });

  test("@prd T-019.5 inspect --json lists the first 20 failures in readable_name order", async () => {
    await withProject(async p => {
      const result = await runCli(["inspect", p, "--json"]);
      const json = JSON.parse(result.stdout);
      const failures: any[] = json.failures;

      expect(result.exitCode).to.equal(0);
      expect(failures).to.be.an("array");
      // Only the fields the case lists are asserted; a list compares element by element.
      const got = failures.map(f => ({
        readable_name: f.readable_name,
        error_message: f.error_message
      }));
      expect(got).to.deep.equal(
        NAMES.slice(0, 20).map(n => ({ readable_name: `s.${n}`, error_message: "e" }))
      );
    });
  });
});
