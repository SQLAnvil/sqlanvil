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

  test(
    "compile throws an error when sqlanvilCoreVersion not in workflow_settings.yaml and no " +
      "package.json exists",
    async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(sqlanvil.WorkflowSettings.create({ defaultProject: "dataform" }))
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
defaultDataset: df_integration_test
defaultAssertionDataset: df_integration_test_assertions
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
        "`dataform install`."
    );
  });

  ["package.json", "package-lock.json", "node_modules"].forEach(npmFile => {
    test(`compile throws an error when sqlanvilCoreVersion in workflow_settings.yaml and ${npmFile} is present`, async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(
          sqlanvil.WorkflowSettings.create({
            defaultProject: "dataform",
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
      execFile(nodePath, [cliEntryPointPath, "init", projectDir, DEFAULT_DATABASE, DEFAULT_LOCATION])
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
          name: "dataform_example_table_assertions_uniqueKey_0",
          schema: "sqlanvil_assertions"
        },
        dependencyTargets: [
          {
            database: DEFAULT_DATABASE,
            name: "example_table",
            schema: "dataform"
          }
        ],
        disabled: true,
        fileName: "definitions/example_table.sqlx",
        parentAction: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "dataform"
        },
        query:
          // tslint:disable-next-line:tsr-detect-sql-literal-injection
          `\nSELECT\n  *\nFROM (\n  SELECT\n    id,\n    COUNT(1) AS index_row_count\n  FROM \`${DEFAULT_DATABASE}.sqlanvil.example_table\`\n  GROUP BY id\n  ) AS data\nWHERE index_row_count > 1\n`,
        target: {
          database: DEFAULT_DATABASE,
          name: "dataform_example_table_assertions_uniqueKey_0",
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
          schema: "dataform"
        },
        disabled: false,
        enumType: "TABLE",
        fileName: "definitions/example_table.sqlx",
        hermeticity: "NON_HERMETIC",
        query: "\n\nSELECT 1 as id\n",
        target: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "dataform"
        },
        type: "table"
      }
    ],
    targets: [
      {
        database: DEFAULT_DATABASE,
        name: "dataform_example_table_assertions_uniqueKey_0",
        schema: "sqlanvil_assertions"
      },
      {
        database: DEFAULT_DATABASE,
        name: "example_table",
        schema: "dataform"
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
        defaultDataset: "dataform",
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
