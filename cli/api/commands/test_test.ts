import { expect } from "chai";

import { test as runTests } from "sa/cli/api/commands/test";
import { LimitedResultSet } from "sa/cli/api/utils/results";
import { suite, test } from "sa/testing";

// A fake adapter that truncates results exactly like the real adapters do (via the
// shared LimitedResultSet), so a test exercising the row/byte caps reproduces the
// production truncation behaviour rather than a hand-rolled approximation of it.
function fakeAdapter(resultsByQuery: { [query: string]: any[] }): any {
  return {
    execute: async (
      statement: string,
      options?: { rowLimit?: number; byteLimit?: number }
    ) => {
      const all = resultsByQuery[statement] || [];
      const set = new LimitedResultSet({
        rowLimit: options?.rowLimit,
        byteLimit: options?.byteLimit
      });
      for (const row of all) {
        if (!set.push(row)) {
          break;
        }
      }
      return { rows: set.rows, metadata: {} };
    }
  };
}

suite("test command result comparison", () => {
  test("compares rows beyond the legacy 1MB cap (no silent truncation)", async () => {
    // ~4KB per row, so 400 rows is well over the old 1MB byteLimit. The legacy cap
    // truncated both sides to the same prefix, so a mismatch beyond the cut was
    // never compared — the test would (incorrectly) report success.
    const big = "x".repeat(2000);
    const actual: any[] = [];
    const expected: any[] = [];
    for (let i = 0; i < 400; i++) {
      actual.push({ id: i, val: big });
      // Identical to actual except a single row far beyond the 1MB cut point.
      expected.push({ id: i, val: i === 350 ? `${big}DIFFERENT` : big });
    }

    const [result] = await runTests(fakeAdapter({ ACTUAL: actual, EXPECTED: expected }), [
      { name: "big", testQuery: "ACTUAL", expectedOutputQuery: "EXPECTED" }
    ]);

    expect(result.successful).equals(false);
    expect(result.messages.join(" ")).to.match(/row 350/);
  });
});
