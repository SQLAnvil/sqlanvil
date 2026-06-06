import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs-extra";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import { cliEntryPointPath } from "sa/cli/index_test_base";
import { version } from "sa/core/version";
import { corePackageTarPath, getProcessResult, nodePath, npmPath, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

// Regression guard for the named-connections feature compiled through the
// PACKAGED (minified) @sqlanvil/core bundle, not the unminified ts_library used
// by the core unit tests.
//
// The bug (fixed in core/main.ts): spreading a protobufjs ProjectConfig message
// instance (`{ ...projectConfig }`) dropped its `connections` MAP field once the
// core bundle was minified by the packager. Scalars survived, maps did not, so
// `connections` was silently `{}` in the published package even though every
// unit test (which runs the unminified code) passed. This suite installs the
// real core tarball into a project and drives `sqlanvil compile` exactly the way
// a published install does, so the minified code path is exercised.
suite("named connections (compiled through packaged core)", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("connections survive the minified core bundle and drive the FDW bridge", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();

    // A supabase warehouse (so the read-only FDW bridge path is valid) with a
    // BigQuery source declared as a named connection.
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({
        warehouse: "supabase",
        defaultDataset: "public",
        defaultAssertionDataset: "sqlanvil_assertions",
        connections: {
          bigquery_public: {
            platform: "bigquery",
            project: "bigquery-public-data",
            dataset: "geo_us_boundaries",
            saKeyId: "vault-secret-id"
          }
        }
      })
    );

    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions", "zip_codes.sqlx"),
      `config {
  type: "declaration",
  connection: "bigquery_public",
  name: "zip_codes",
  columnTypes: { zip_code: "text" }
}`
    );

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`
    );

    // Install the real (minified) core tarball into the project, mirroring a
    // published `@sqlanvil/core` install. This is the code path the unit tests
    // never exercise.
    await getProcessResult(
      execFile(npmPath, [
        "install",
        "--prefix",
        projectDir,
        "--cache",
        npmCacheDir,
        corePackageTarPath
      ])
    );

    const compileResult = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"])
    );

    expect(compileResult.exitCode, `compile failed: ${compileResult.stderr}`).equals(0);
    const compiled = JSON.parse(compileResult.stdout);

    // 1. The directly-dropped field: `connections` must round-trip through the
    //    minified ProjectConfig. Under the bug this was `{}`.
    expect(compiled.projectConfig.connections, "projectConfig.connections was dropped").to.have.property(
      "bigquery_public"
    );

    // 2. End-to-end proof the connection is usable: a connection-tagged
    //    declaration routes through declare(), which looks the connection up in
    //    projectConfig.connections. Under the bug that lookup failed and emitted
    //    an "Unknown connection" compilation error instead of the FDW bridge.
    expect(compiled.graphErrors.compilationErrors || [], "unexpected compilation errors").to.deep.equal(
      []
    );

    // 3. The FDW bridge actions (Wrapper server-setup operation + ref-able
    //    foreign table) are emitted under `operations`.
    const operationTargets = (compiled.operations || []).map((op: any) => op.target);
    const serverNames = operationTargets.map((t: any) => t.name);
    expect(serverNames, "FDW server-setup operation missing").to.include("bigquery_public_srv");
    const foreignTable = operationTargets.find(
      (t: any) => t.name === "zip_codes" && t.schema === "bigquery_public_ext"
    );
    expect(foreignTable, "ref-able foreign table missing").to.not.equal(undefined);
  });
});
