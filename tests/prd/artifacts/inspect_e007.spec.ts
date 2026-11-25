// Characterization tests for more than 20 failures (E-007): T-018.7 (AC-018.3, the table) and
// T-019.5 (AC-019.1, --json). Written from docs/prd/sqlanvil/test-cases/artifacts.yaml,
// features/artifacts.md (AC-011.1, AC-018.3, AC-019.1) and testing.md (Harness) only.
import { expect } from "chai";

import { writeArtifacts } from "sa/cli/api/commands/artifacts";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { expectFields, lines, runCli, withTmpDir } from "sa/tests/prd/artifacts/helpers";

const write: any = writeArtifacts;

// The names f01 .. f21 of the tables s.f01 .. s.f21.
const NAMES: string[] = [];
for (let i = 1; i <= 21; i++) {
  NAMES.push(`f${String(i).padStart(2, "0")}`);
}

// G21: 21 tables s.f01 to s.f21. A graph described in prose holds only what it names: every other
// action list is empty, and a table with no stated type has no enumType (testing.md, Assertions).
function g21(): any {
  return {
    tables: NAMES.map((name) => ({ target: { schema: "s", name } })),
    operations: [] as any[],
    assertions: [] as any[],
    exports: [] as any[],
    declarations: [] as any[],
  };
}

// R21R: status FAILED and one FAILED action result per table, listed in reverse readable_name
// order (s.f21 first, s.f01 last), each with timing {startTimeMillis: 10, endTimeMillis: 20} and
// tasks [{errorMessage: e}].
function r21r(): any {
  return {
    status: sqlanvil.RunResult.ExecutionStatus.FAILED,
    actions: [...NAMES].reverse().map((name) => ({
      target: { schema: "s", name },
      status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
      timing: { startTimeMillis: 10, endTimeMillis: 20 },
      tasks: [{ errorMessage: "e" }],
    })),
  };
}

// The first 20 failures in readable_name order: s.f01 to s.f20.
const FIRST_20 = NAMES.slice(0, 20).map((name) => `s.${name}`);

suite("prd artifacts: inspect with more than 20 failures", () => {
  test("@prd T-018.7 inspect lists the first 20 of 21 failures in readable_name order", async () => {
    await withTmpDir(async (P) => {
      await write(g21(), P, { runResult: r21r(), runId: 5 });
      const r = await runCli(["inspect", P]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      expect(r.stdout.includes("\r"), "stdout holds no CR").to.equal(false);
      const out = lines(r.stdout);
      const at = out.indexOf("Failures:");
      expect(at, "a `Failures:` line").to.be.at.least(0);
      // AC-011.1: each value padded to its column's width (the longest of the column name and its
      // values: 13 for both columns here), the columns separated by two spaces, then an empty line
      // and `(<n> rows)`.
      expect(out.slice(at + 1)).to.deep.equal([
        "readable_name  error_message",
        "-------------  -------------",
        ...FIRST_20.map((name) => `${name.padEnd(13)}  ${"e".padEnd(13)}`),
        "",
        "(20 rows)",
      ]);
    });
  });

  test("@prd T-019.5 inspect --json lists the first 20 of 21 failures in readable_name order", async () => {
    await withTmpDir(async (P) => {
      await write(g21(), P, { runResult: r21r(), runId: 5 });
      const r = await runCli(["inspect", P, "--json"]);
      expect(r.exitCode, `exit code; stderr: ${r.stderr}`).to.equal(0);
      // Only the fields the case lists are asserted; the list compares element by element.
      expectFields(JSON.parse(r.stdout), {
        failures: FIRST_20.map((name) => ({ readable_name: name, error_message: "e" })),
      });
    });
  });
});
