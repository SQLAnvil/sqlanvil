// FR-042: no script in the repository bumps DF_VERSION (docs/prd/sqlanvil/features/release.md).
// Every expected value comes from docs/prd/sqlanvil/test-cases/release.yaml.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";

import { workspaceRoot } from "./helpers";
import { KnownFailure, strictKnownFailure } from "./known_failing";

/** Whether anything (a file, a directory or a link, dangling or not) is at `p`. */
function somethingAt(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw e;
  }
}

suite("release: update_version", () => {
  test("@prd T-042.1 known-failing E-016 scripts/update_version does not exist", async () => {
    await strictKnownFailure("E-016", async () => {
      const target = path.join(workspaceRoot(), "scripts", "update_version");
      const exists = somethingAt(target);
      // The case's symptom names a state: it is observed before the other assertions.
      if (exists) {
        throw new KnownFailure("E-016", "scripts/update_version still exists under the workspace root");
      }
      // output: {scripts/update_version_exists: false}
      expect(exists).to.equal(false);
      // effects: no file or directory exists at scripts/update_version under the workspace root
      expect(fs.existsSync(target)).to.equal(false);
    });
  });
});
