// Release area: the bundler configurations (FR-031 AC-031.3, FR-032 AC-032.4;
// test-cases/release.yaml T-031.3, T-032.4).

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { nodePath, suite, test } from "sa/testing";
import { childEnv, run, runfile, runfilesRoot, source, withTemp, workspaceRoot, writeFile } from "./helpers";

function rollupBin(): string {
  const pkgDir = runfile("node_modules/rollup");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.rollup;
  return path.join(pkgDir, bin);
}

suite("release bundlers", () => {
  test("@prd T-031.3 rollup refuses a bare import that is not a listed external", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "entry.js"), 'const x = require("left-pad"); module.exports = x;');
      source("packages/rollup.config.mjs");
      const r = await run(
        nodePath,
        [
          rollupBin(),
          "-c",
          "packages/rollup.config.mjs",
          "--external=yargs",
          "--format=cjs",
          "-i",
          path.join(T, "entry.js"),
          "-o",
          path.join(T, "out.js"),
        ],
        { cwd: workspaceRoot(), env: childEnv() },
      );
      expect(r.exitCode, "exit code").not.equals(0);
      expect(r.stderr).to.include("Must explicitly list import as an external: left-pad");
      expect(fs.existsSync(path.join(T, "out.js")), "T/out.js does not exist").equals(false);
    });
  });

  test("@prd T-032.4 the core and sample-extension webpack configs throw without BAZEL_BINDIR", async () => {
    await withTemp(async (T) => {
      const child = path.join(T, "child.js");
      writeFile(
        child,
        [
          "const file = process.argv[2];",
          "try {",
          "  require(file)({}, {});",
          "  process.stdout.write(JSON.stringify({ threw: false }));",
          "} catch (e) {",
          "  const message = e && e.message !== undefined ? String(e.message) : String(e);",
          "  process.stdout.write(JSON.stringify({ threw: true, message }));",
          "}",
        ].join("\n"),
      );
      for (const config of [
        "packages/@sqlanvil/core/webpack.config.js",
        "packages/sample-extension/webpack.config.js",
      ]) {
        const r = await run(
          nodePath,
          ["--require", runfile("testing/resolver-patch.js"), child, source(config)],
          { cwd: runfilesRoot(), env: childEnv({ BAZEL_BINDIR: undefined }) },
        );
        expect(r.exitCode, `${config}: child exit (${r.stderr})`).equals(0);
        const out = JSON.parse(r.stdout);
        expect(out.threw, `${config} throws`).equals(true);
        expect(out.message, `${config} error`).equals("BAZEL_BINDIR must be set");
      }
    });
  });
});
