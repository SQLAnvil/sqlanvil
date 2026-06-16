import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs-extra";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import * as path from "path";

import { cliEntryPointPath, DEFAULT_DATABASE, DEFAULT_LOCATION } from "sa/cli/index_test_base";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";
import { corePackageTarPath, getProcessResult, nodePath, npmPath, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("compile command", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  // The two tests below exercise the stateless-install path against SPECIFIC
  // published @sqlanvil/core versions (2.9.0, 3.0.50) fetched from the public npm
  // registry. Those versions aren't published yet (only 0.0.1 placeholders exist),
  // so the tests are gated off by default — keeping //cli:tests green. Set
  // SA_TEST_PUBLISHED_CORE=1 (and pass via --test_env) to run them once real
  // @sqlanvil/core versions exist on npm. See docs npm_publishing.md.
  const runPublishedCoreTests = !!process.env.SA_TEST_PUBLISHED_CORE;

  test(
    "compile throws an error when sqlanvilCoreVersion not in workflow_settings.yaml and no " +
      "package.json exists",
    async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(sqlanvil.WorkflowSettings.create({ defaultProject: "sqlanvil" }))
      );

      expect(
        (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
          .stderr
      ).contains(
        "sqlanvilCoreVersion must be specified either in workflow_settings.yaml or via a " +
          "package.json"
      );
    }
  );

  test("compile error when package.json and no package is installed", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`
    );
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: tada-analytics
defaultDataset: sa_integration_test
defaultAssertionDataset: sa_integration_test_assertions
defaultLocation: "${DEFAULT_LOCATION}"
`
    );

    expect(
      (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
        .stderr
    ).contains(
      "Could not find a recent installed version of @sqlanvil/core in the project. Check that " +
        "either `sqlanvilCoreVersion` is specified in `workflow_settings.yaml`, or " +
        "`@sqlanvil/core` is specified in `package.json`. If using `package.json`, then run " +
        "`sqlanvil install`."
    );
  });

  if (runPublishedCoreTests) {
  test("compile rejects @sqlanvil/core with incompatible version", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    // sqlanvilCoreVersion in workflow_settings.yaml triggers the stateless
    // install path (compile.ts copies to a tmp dir and runs `npm i`), so the
    // test exercises the same flow real users hit. 2.9.0 is the latest 2.x on
    // the registry; its major (2) is incompatible with the current CLI (3.x).
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml(
        sqlanvil.WorkflowSettings.create({
          defaultProject: "dataform",
          sqlanvilCoreVersion: "2.9.0"
        })
      )
    );

    // npm needs a writable cache; ~/.npm is read-only in the bazel sandbox.
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const stderr = (
      await getProcessResult(
        execFile(nodePath, [cliEntryPointPath, "compile", projectDir], {
          env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir }
        })
      )
    ).stderr;
    expect(stderr).contains("@sqlanvil/core 2.9.0 is not compatible with @sqlanvil/cli");
    expect(stderr).contains("matching major.minor");
    expect(stderr).contains("Set `sqlanvilCoreVersion:");
  });

  test("compile succeeds with @sqlanvil/core <= 3.0.56 via caller-file shim", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    // 3.0.50 predates 3.0.57, which is when @sqlanvil/core started reading
    // global.__sqlanvil_current_file as a fallback in getCallerFile(). The
    // compile path text-patches the bundle to add that fallback; this test
    // proves the patch + host-side file stack drive a real action's
    // fileName from inside vm2 3.11.3's path-stripped sandbox.
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({
        defaultProject: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        defaultDataset: "dataform",
        sqlanvilCoreVersion: "3.0.50"
      })
    );
    fs.ensureFileSync(path.join(projectDir, "definitions", "example.sqlx"));
    fs.writeFileSync(
      path.join(projectDir, "definitions", "example.sqlx"),
      `config { type: "table" }\nSELECT 1 AS id`
    );

    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"], {
        env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir }
      })
    );

    expect(result.exitCode, `compile failed: ${result.stderr}`).equals(0);
    const compiled = JSON.parse(result.stdout);
    expect(compiled.tables).to.have.lengthOf(1);
    expect(compiled.tables[0].fileName).equals("definitions/example.sqlx");
  });
  } // end runPublishedCoreTests gate

  ["package.json", "package-lock.json", "node_modules"].forEach(npmFile => {
    test(`compile throws an error when sqlanvilCoreVersion in workflow_settings.yaml and ${npmFile} is present`, async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(
          sqlanvil.WorkflowSettings.create({
            defaultProject: "sqlanvil",
            sqlanvilCoreVersion: "3.0.0"
          })
        )
      );
      const resolvedNpmPath = path.join(projectDir, npmFile);
      if (npmFile === "node_modules") {
        fs.mkdirSync(resolvedNpmPath);
      } else {
        fs.writeFileSync(resolvedNpmPath, "");
      }

      expect(
        (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
          .stderr
      ).contains(`${npmFile}' unexpected; remove it and try again`);
    });
  });
});

suite("disable-assertions flag (compilation)", ({ afterEach, beforeEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);
  let projectDir: string;

  async function setupTestProject(): Promise<void> {
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const packageJsonPath = path.join(projectDir, "package.json");

    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        // This suite asserts BigQuery compile output; init now defaults to supabase.
        "--warehouse=bigquery",
        DEFAULT_DATABASE,
        DEFAULT_LOCATION
      ])
    );

    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8"))
    );
    delete workflowSettings.sqlanvilCoreVersion;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));

    fs.writeFileSync(
      packageJsonPath,
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`
    );
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

    const assertionFilePath = path.join(projectDir, "definitions", "test_assertion.sqlx");
    fs.ensureFileSync(assertionFilePath);
    fs.writeFileSync(
      assertionFilePath,
      `
config { type: "assertion" }
SELECT 1 WHERE FALSE
`
    );

    const tableFilePath = path.join(projectDir, "definitions", "example_table.sqlx");
    fs.ensureFileSync(tableFilePath);
    fs.writeFileSync(
      tableFilePath,
      `
config {
  type: "table",
  assertions: {
    uniqueKey: ["id"]
  }
}
SELECT 1 as id
`
    );
  }

  async function setUpWorkflowSettings(disableAssertions: boolean): Promise<void> {
    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8"))
    );
    workflowSettings.disableAssertions = disableAssertions;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
  }

  beforeEach("setup test project", async () => {
    projectDir = tmpDirFixture.createNewTmpDir();
    await setupTestProject();
  });

  const expectedCompileResult = {
    assertions: [
      {
        canonicalTarget: {
          database: DEFAULT_DATABASE,
          name: "sqlanvil_example_table_assertions_uniqueKey_0",
          schema: "sqlanvil_assertions"
        },
        dependencyTargets: [
          {
            database: DEFAULT_DATABASE,
            name: "example_table",
            schema: "sqlanvil"
          }
        ],
        disabled: true,
        fileName: "definitions/example_table.sqlx",
        parentAction: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil"
        },
        query:
          // tslint:disable-next-line:tsr-detect-sql-literal-injection
          `\nSELECT\n  *\nFROM (\n  SELECT\n    id,\n    COUNT(1) AS index_row_count\n  FROM \`${DEFAULT_DATABASE}.sqlanvil.example_table\`\n  GROUP BY id\n  ) AS data\nWHERE index_row_count > 1\n`,
        target: {
          database: DEFAULT_DATABASE,
          name: "sqlanvil_example_table_assertions_uniqueKey_0",
          schema: "sqlanvil_assertions"
        }
      },
      {
        canonicalTarget: {
          database: DEFAULT_DATABASE,
          name: "test_assertion",
          schema: "sqlanvil_assertions"
        },
        disabled: true,
        fileName: "definitions/test_assertion.sqlx",
        query: "\n\nSELECT 1 WHERE FALSE\n",
        target: {
          database: DEFAULT_DATABASE,
          name: "test_assertion",
          schema: "sqlanvil_assertions"
        }
      }
    ],
    sqlanvilCoreVersion: version,
    graphErrors: {},
    jitData: {},
    projectConfig: {
      assertionSchema: "sqlanvil_assertions",
      defaultDatabase: DEFAULT_DATABASE,
      defaultLocation: DEFAULT_LOCATION,
      defaultSchema: "sqlanvil",
      disableAssertions: true,
      warehouse: "bigquery"
    },
    tables: [
      {
        canonicalTarget: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil"
        },
        disabled: false,
        enumType: "TABLE",
        fileName: "definitions/example_table.sqlx",
        hermeticity: "NON_HERMETIC",
        query: "\n\nSELECT 1 as id\n",
        target: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil"
        },
        type: "table"
      }
    ],
    targets: [
      {
        database: DEFAULT_DATABASE,
        name: "sqlanvil_example_table_assertions_uniqueKey_0",
        schema: "sqlanvil_assertions"
      },
      {
        database: DEFAULT_DATABASE,
        name: "example_table",
        schema: "sqlanvil"
      },
      {
        database: DEFAULT_DATABASE,
        name: "test_assertion",
        schema: "sqlanvil_assertions"
      }
    ]
  };

  test("with --disable-assertions flag", async () => {
    await setUpWorkflowSettings(false);

    const compileResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--json",
        "--disable-assertions"
      ])
    );

    expect(compileResult.exitCode).equals(0);
    expect(JSON.parse(compileResult.stdout)).deep.equals(expectedCompileResult);
  });

  test("with disableAssertions set in workflow_settings.yaml", async () => {
    await setUpWorkflowSettings(true);

    const compileResult = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"])
    );

    expect(compileResult.exitCode).equals(0);
    expect(JSON.parse(compileResult.stdout)).deep.equals(expectedCompileResult);
  });
});

suite("compile node selection", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  // Builds a project with three tables: upstream -> midstream -> downstream.
  async function setupSelectionProject(): Promise<string> {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();

    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        "--warehouse=bigquery",
        DEFAULT_DATABASE,
        DEFAULT_LOCATION
      ])
    );

    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8"))
    );
    delete workflowSettings.sqlanvilCoreVersion;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`
    );
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

    const def = (name: string, contents: string) => {
      const filePath = path.join(projectDir, "definitions", `${name}.sqlx`);
      fs.ensureFileSync(filePath);
      fs.writeFileSync(filePath, contents);
    };
    def("upstream", `config { type: "table", tags: ["daily"] }\nSELECT 1 AS id`);
    def("midstream", `config { type: "table" }\nSELECT * FROM \${ref("upstream")}`);
    def("downstream", `config { type: "table" }\nSELECT * FROM \${ref("midstream")}`);

    return projectDir;
  }

  const tableNames = (stdout: string): string[] =>
    JSON.parse(stdout).tables.map((table: any) => table.target.name).sort();

  test("no selector emits the entire graph", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["downstream", "midstream", "upstream"]);
  });

  test("--actions filters output to the selected action", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--actions", "midstream", "--json"])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["midstream"]);
  });

  test("--actions --include-deps pulls in upstream dependencies", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--actions",
        "midstream",
        "--include-deps",
        "--json"
      ])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["midstream", "upstream"]);
  });

  test("--actions --include-dependents pulls in downstream dependents", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--actions",
        "midstream",
        "--include-dependents",
        "--json"
      ])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["downstream", "midstream"]);
  });

  test("--tags filters output to actions carrying the tag", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--tags", "daily", "--json"])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["upstream"]);
  });

  test("selector matching nothing emits an empty graph and exits zero", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--actions", "nope", "--json"])
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals([]);
  });

  test("--include-deps without a selector is rejected", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--include-deps", "--json"])
    );
    expect(result.exitCode).not.equals(0);
    expect(result.stderr).contains("--include-deps");
  });
});

suite("extension config", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("compile succeeds with extension set in workflow_settings.yaml", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();

    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({
        defaultProject: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        defaultDataset: "sqlanvil",
        defaultAssertionDataset: "sqlanvil_assertions",
        extension: {
          name: "test-extension",
          compilationMode: "PROLOGUE",
        },
      })
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.mkdirSync(path.join(projectDir, "includes"));

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`
    );
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
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir])
    );

    expect(compileResult.exitCode).equals(0);
    expect(compileResult.stdout).contains("Compiled 0 action(s).");
  });
});
