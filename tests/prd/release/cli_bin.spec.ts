// Release area: the CLI dev entry point //packages/@sqlanvil/cli:bin
// (FR-034; test-cases/release.yaml T-034.1).

import { expect } from "chai";

import { suite, test } from "sa/testing";
import { binary, childEnv, fileLines, run, runfilesRoot, versions, withTemp } from "./helpers";

suite("release cli bin", () => {
  test("@prd T-034.1 cli:bin --version prints sqlanvil SV (Dataform core DV)", async () => {
    await withTemp(async (T) => {
      // The case's env: NO_COLOR=1, BUILD_WORKING_DIRECTORY=T, BAZEL_BINDIR=. ; the binary runs
      // from its runfiles (testing.md, Harness, Layout), never through `bazel run`.
      const r = await run(binary("packages/@sqlanvil/cli", "bin"), ["--version"], {
        cwd: runfilesRoot(),
        env: childEnv({ NO_COLOR: "1", BUILD_WORKING_DIRECTORY: T, BAZEL_BINDIR: "." }),
      });
      const { sv, dv } = versions();
      expect(r.exitCode, `exit_code (stderr: ${r.stderr})`).equals(0);
      expect(fileLines(r.stdout), "stdout_line").to.include(`sqlanvil ${sv} (Dataform core ${dv})`);
    });
  });
});
