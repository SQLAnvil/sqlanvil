// A DuckDB binding that fails to load: FR-017 of docs/prd/sqlanvil/features/artifacts.md.
import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { getProcessResult, nodePath, suite, test } from "sa/testing";
import { filesUnder, withTmpDir } from "sa/tests/prd/artifacts/helpers";

const RESULT_MARKER = "__PRD_T_017_1_RESULT__";
const PREFIX =
  'Artifacts skipped: This feature requires the optional "@duckdb/node-api" dependency, which failed to load: ';

suite("prd artifacts: DuckDB binding", () => {
  test("@prd T-017.1 safeWriteArtifacts warns when @duckdb/node-api fails to load", async () => {
    await withTmpDir(async (P) => {
      const r = await getProcessResult(
        execFile(nodePath, [
          "--require",
          path.resolve("testing/resolver-patch.js"),
          "--require",
          path.resolve("tests/prd/artifacts/duckdb_block_preload.js"),
          path.resolve("tests/prd/artifacts/duckdb_fail_child.js"),
          P,
        ]),
      );
      const line = r.stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
      expect(line, `child result line; exit ${r.exitCode}; stderr: ${r.stderr}`).to.not.equal(
        undefined,
      );
      const result = JSON.parse(line!.slice(RESULT_MARKER.length));
      expect(result.resolved, `resolves; error: ${result.error}`).to.equal(true);
      expect(result.warnings.length, JSON.stringify(result.warnings)).to.equal(1);
      expect(result.warnings[0].startsWith(PREFIX), result.warnings[0]).to.equal(true);
      const target = path.join(P, "target");
      const parquet = fs.existsSync(target)
        ? filesUnder(target).filter((f) => f.endsWith(".parquet"))
        : [];
      expect(parquet).to.deep.equal([]);
    });
  });
});
