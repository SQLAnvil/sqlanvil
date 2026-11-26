// Release area: scripts/regenerate_docs refusing to run without the site or the Bazel outputs
// (FR-040; test-cases/release.yaml T-040.1 to T-040.4). No case here uses Docker or the network.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import {
  allPaths,
  childEnv,
  fileContents,
  fileLines,
  mapsEqual,
  ProcessResult,
  run,
  withTemp,
  workspaceRoot,
  writeFile,
} from "./helpers";

function copyScript(dest: string) {
  writeFile(dest, fs.readFileSync(path.join(workspaceRoot(), "scripts", "regenerate_docs")));
  fs.chmodSync(dest, 0o755);
}

async function regenerate(
  script: string,
  cwd: string,
  env: { [key: string]: string | undefined },
): Promise<ProcessResult> {
  return run(script, [], {
    cwd,
    env: childEnv({ COM_REPO: undefined, PROTOC_GEN_DOC_IMAGE: undefined, ...env }),
  });
}

suite("release regenerate_docs refusals", () => {
  test("@prd T-040.1 a missing site stops with its error and writes nothing", async () => {
    await withTemp(async (T) => {
      copyScript(path.join(T, "scripts", "regenerate_docs"));
      const before = allPaths(T);
      const site = path.join(T, "site");
      const r = await regenerate(path.join(T, "scripts", "regenerate_docs"), T, { COM_REPO: site });
      expect(r.exitCode, `exit code (${r.stderr})`).equals(1);
      expect(fileLines(r.stdout)).to.include(
        `ERROR: ${site}/src/content/docs/docs/reference not found. Clone the site repo: git clone git@github.com:SQLAnvil/sqlanvil-com.git ${site}`,
      );
      const added = allPaths(T).filter((p) => !before.includes(p));
      expect(added, "T gains no new file or directory").deep.equals([]);
    });
  });

  test("@prd T-040.2 a missing bazel-bin/protos/ts.d.ts stops with its error, the site unchanged", async () => {
    await withTemp(async (T) => {
      copyScript(path.join(T, "scripts", "regenerate_docs"));
      const site = path.join(T, "site");
      writeFile(path.join(site, "src", "content", "docs", "docs", "reference", "table.md"), "old");
      const before = fileContents(site);
      const r = await regenerate(path.join(T, "scripts", "regenerate_docs"), T, { COM_REPO: site });
      expect(r.exitCode, "exit code").equals(1);
      expect(fileLines(r.stderr)).to.include(
        "bazel-bin/protos/ts.d.ts missing — run: bazel build //protos:ts //core:version",
      );
      expect(mapsEqual(fileContents(site), before), "the files under T/site are unchanged").equals(true);
    });
  });

  test("@prd T-040.3 a missing bazel-bin/core/version.ts stops with its error and cleans up", async () => {
    await withTemp(async (T) => {
      copyScript(path.join(T, "scripts", "regenerate_docs"));
      const site = path.join(T, "site");
      fs.mkdirSync(path.join(site, "src", "content", "docs", "docs", "reference"), { recursive: true });
      fs.mkdirSync(path.join(T, "protos"), { recursive: true });
      fs.mkdirSync(path.join(T, "core"), { recursive: true });
      writeFile(path.join(T, "bazel-bin", "protos", "ts.d.ts"), "x");
      const r = await regenerate(path.join(T, "scripts", "regenerate_docs"), T, { COM_REPO: site });
      expect(r.exitCode, "exit code").equals(1);
      expect(fileLines(r.stderr)).to.include(
        "bazel-bin/core/version.ts missing — run: bazel build //protos:ts //core:version",
      );
      for (const rel of ["protos/ts.d.ts", "core/version.ts", "newdocs", ".docs_gen"]) {
        expect(fs.existsSync(path.join(T, rel)), `T/${rel} does not exist`).equals(false);
      }
    });
  });

  test("@prd T-040.4 with COM_REPO unset, the site is looked for beside the repository root", async () => {
    await withTemp(async (T) => {
      copyScript(path.join(T, "repo", "scripts", "regenerate_docs"));
      const other = path.join(T, "other");
      fs.mkdirSync(path.join(other, "sqlanvil-com", "src", "content", "docs", "docs", "reference"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(other, "sub"), { recursive: true });
      const before = fileContents(other);
      const r = await regenerate(path.join(T, "repo", "scripts", "regenerate_docs"), path.join(other, "sub"), {
        COM_REPO: undefined,
      });
      expect(r.exitCode, `exit code (${r.stderr})`).equals(1);
      expect(r.stdout, "stdout_contains").to.include("src/content/docs/docs/reference not found. Clone the site repo");
      expect(mapsEqual(fileContents(other), before), "the files under T/other are unchanged").equals(true);
    });
  });
});
