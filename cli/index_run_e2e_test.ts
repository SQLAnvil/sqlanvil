import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs-extra";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import * as path from "path";

import {
  cliEntryPointPath,
  CREDENTIALS_PATH,
  DEFAULT_DATABASE,
  DEFAULT_LOCATION,
  DEFAULT_RESERVATION,
} from "sa/cli/index_test_base";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";
import { corePackageTarPath, getProcessResult, nodePath, npmPath, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("run e2e", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("golden path with package.json", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const packageJsonPath = path.join(projectDir, "package.json");

    // Initialize a project using the CLI, don't install packages.
    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        DEFAULT_DATABASE,
        DEFAULT_LOCATION,
        "--warehouse",
        "bigquery",
        "--bare",
      ]),
    );

    // Install packages manually to get around bazel read-only sandbox issues.
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
    );
    delete workflowSettings.sqlanvilCoreVersion;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
    fs.writeFileSync(
      packageJsonPath,
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
    );
    await getProcessResult(
      execFile(npmPath, [
        "install",
        "--prefix",
        projectDir,
        "--cache",
        npmCacheDir,
        corePackageTarPath,
      ]),
    );

    // Write a simple file to the project.
    const filePath = path.join(projectDir, "definitions", "example.sqlx");
    fs.ensureFileSync(filePath);
    fs.writeFileSync(
      filePath,
      `
config { type: "table", tags: ["someTag"] }
select 1 as \${sqlanvil.projectConfig.vars.testVar2}
`,
    );

    // Compile the project using the CLI.
    const compileResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--json",
        "--vars=testVar1=testValue1,testVar2=testValue2",
        "--schema-suffix=test_schema_suffix",
      ]),
    );

    expect(compileResult.exitCode).equals(0);

    expect(JSON.parse(compileResult.stdout)).deep.equals({
      tables: [
        {
          type: "table",
          enumType: "TABLE",
          target: {
            database: DEFAULT_DATABASE,
            schema: "sqlanvil_test_schema_suffix",
            name: "example",
          },
          canonicalTarget: {
            schema: "sqlanvil",
            name: "example",
            database: DEFAULT_DATABASE,
          },
          query: "\n\nselect 1 as testValue2\n",
          disabled: false,
          fileName: "definitions/example.sqlx",
          hermeticity: "NON_HERMETIC",
          tags: ["someTag"],
        },
      ],
      projectConfig: {
        warehouse: "bigquery",
        defaultSchema: "sqlanvil",
        assertionSchema: "sqlanvil_assertions",
        defaultDatabase: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        vars: {
          testVar1: "testValue1",
          testVar2: "testValue2",
        },
        schemaSuffix: "test_schema_suffix",
      },
      graphErrors: {},
      jitData: {},
      sqlanvilCoreVersion: version,
      targets: [
        {
          database: DEFAULT_DATABASE,
          schema: "sqlanvil",
          name: "example",
        },
      ],
    });

    // Dry run the project.
    const runResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "run",
        projectDir,
        "--credentials",
        CREDENTIALS_PATH,
        "--build-only",
        "--json",
        "--vars=testVar1=testValue1,testVar2=testValue2",
        "--default-location=europe",
        "--tags=someTag,someOtherTag",
        "--actions=example,someOtherAction",
      ]),
    );

    if (runResult.exitCode !== 0 || runResult.stdout.trim().length === 0) {
      // tslint:disable-next-line:no-console
      console.error("GOLDEN PATH FAILED. STDERR:", runResult.stderr);
    }
    expect(runResult.exitCode).equals(0);

    expect(JSON.parse(runResult.stdout)).deep.equals({
      actions: [
        {
          fileName: "definitions/example.sqlx",
          hermeticity: "NON_HERMETIC",
          tableType: "table",
          target: {
            database: DEFAULT_DATABASE,
            name: "example",
            schema: "sqlanvil",
          },
          tasks: [
            {
              statement:
                // tslint:disable-next-line:tsr-detect-sql-literal-injection
                `create or replace table \`${DEFAULT_DATABASE}.sqlanvil.example\` as \n\nselect 1 as testValue2`,
              type: "statement",
            },
          ],
          type: "table",
        },
      ],
      projectConfig: {
        assertionSchema: "sqlanvil_assertions",
        defaultDatabase: DEFAULT_DATABASE,
        defaultLocation: "europe",
        defaultSchema: "sqlanvil",
        warehouse: "bigquery",
        vars: {
          testVar1: "testValue1",
          testVar2: "testValue2",
        },
      },
      runConfig: {
        fullRefresh: false,
        tags: ["someTag", "someOtherTag"],
        actions: ["example", "someOtherAction"],
      },
      warehouseState: {},
    });
  });

  suite("disable-assertions flag (run)", ({ beforeEach }) => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    async function setupTestProject(): Promise<void> {
      const npmCacheDir = tmpDirFixture.createNewTmpDir();
      const packageJsonPath = path.join(projectDir, "package.json");

      await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "init",
          projectDir,
          DEFAULT_DATABASE,
          DEFAULT_LOCATION,
          "--warehouse",
          "bigquery",
          "--bare",
        ]),
      );

      const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
      const workflowSettings = sqlanvil.WorkflowSettings.create(
        loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
      );
      delete workflowSettings.sqlanvilCoreVersion;
      fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));

      fs.writeFileSync(
        packageJsonPath,
        `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
      );
      await getProcessResult(
        execFile(npmPath, [
          "install",
          "--prefix",
          projectDir,
          "--cache",
          npmCacheDir,
          corePackageTarPath,
        ]),
      );

      const assertionFilePath = path.join(projectDir, "definitions", "test_assertion.sqlx");
      fs.ensureFileSync(assertionFilePath);
      fs.writeFileSync(
        assertionFilePath,
        `
config { type: "assertion" }
SELECT 1 WHERE FALSE
`,
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
`,
      );
    }

    async function setUpWorkflowSettings(disableAssertions: boolean): Promise<void> {
      const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
      const workflowSettings = sqlanvil.WorkflowSettings.create(
        loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
      );
      delete workflowSettings.sqlanvilCoreVersion;
      workflowSettings.disableAssertions = disableAssertions;
      fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
    }

    beforeEach("setup test project", async () => await setupTestProject());

    const expectedRunResult = {
      actions: [
        {
          fileName: "definitions/example_table.sqlx",
          hermeticity: "NON_HERMETIC",
          tableType: "table",
          target: {
            database: DEFAULT_DATABASE,
            name: "example_table",
            schema: "sqlanvil",
          },
          tasks: [
            {
              statement:
                // tslint:disable-next-line:tsr-detect-sql-literal-injection
                `create or replace table \`${DEFAULT_DATABASE}.sqlanvil.example_table\` as \n\nSELECT 1 as id`,
              type: "statement",
            },
          ],
          type: "table",
        },
        {
          fileName: "definitions/test_assertion.sqlx",
          hermeticity: "HERMETIC",
          target: {
            database: DEFAULT_DATABASE,
            name: "test_assertion",
            schema: "sqlanvil_assertions",
          },
          type: "assertion",
        },
      ],
      projectConfig: {
        assertionSchema: "sqlanvil_assertions",
        defaultDatabase: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        defaultSchema: "sqlanvil",
        disableAssertions: true,
        warehouse: "bigquery",
      },
      runConfig: {
        actions: ["test_assertion", "example_table"],
        fullRefresh: false,
      },
      warehouseState: {},
    };

    test("with --disable-assertions flag", async () => {
      await setUpWorkflowSettings(false);

      const runResult = await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "run",
          projectDir,
          "--credentials",
          CREDENTIALS_PATH,
          "--build-only",
          "--json",
          "--disable-assertions",
          "--actions=test_assertion,example_table",
        ]),
      );

      if (runResult.exitCode !== 0 || runResult.stdout.trim().length === 0) {
        // tslint:disable-next-line:no-console
        console.error("ASSERTIONS TEST FAILED. STDERR:", runResult.stderr);
      }
      expect(runResult.exitCode).equals(0);
      expect(JSON.parse(runResult.stdout)).deep.equals(expectedRunResult);
    });

    test("with disableAssertions set in workflow_settings.yaml", async () => {
      await setUpWorkflowSettings(true);

      const runResult = await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "run",
          projectDir,
          "--credentials",
          CREDENTIALS_PATH,
          "--build-only",
          "--json",
          "--actions=test_assertion,example_table",
        ]),
      );

      if (runResult.exitCode !== 0 || runResult.stdout.trim().length === 0) {
        // tslint:disable-next-line:no-console
        console.error("ASSERTIONS TEST FAILED. STDERR:", runResult.stderr);
      }
      expect(runResult.exitCode).equals(0);
      expect(JSON.parse(runResult.stdout)).deep.equals(expectedRunResult);
    });

    test("with --job-labels flag", async () => {
      await setUpWorkflowSettings(false);

      const runResult = await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "run",
          projectDir,
          "--credentials",
          CREDENTIALS_PATH,
          "--build-only",
          "--json",
          "--disable-assertions",
          "--actions=test_assertion,example_table",
          "--job-labels=env=testing,team=sqlanvil",
        ]),
      );

      if (runResult.exitCode !== 0 || runResult.stdout.trim().length === 0) {
        // tslint:disable-next-line:no-console
        console.error("ASSERTIONS TEST FAILED. STDERR:", runResult.stderr);
      }
      expect(runResult.exitCode).equals(0);
      expect(JSON.parse(runResult.stdout)).deep.equals(expectedRunResult);
    });
  });

  suite("--default-reservation flag", ({ beforeEach }) => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    beforeEach("setup test project", async () => {
      const npmCacheDir = tmpDirFixture.createNewTmpDir();
      const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
      const packageJsonPath = path.join(projectDir, "package.json");

      await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "init",
          projectDir,
          DEFAULT_DATABASE,
          DEFAULT_LOCATION,
          "--warehouse",
          "bigquery",
          "--bare",
        ]),
      );

      // Remove sqlanvilCoreVersion so we can use the local package.
      const workflowSettings = sqlanvil.WorkflowSettings.create(
        loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
      );
      delete workflowSettings.sqlanvilCoreVersion;
      fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));

      fs.writeFileSync(
        packageJsonPath,
        `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
      );
      await getProcessResult(
        execFile(npmPath, [
          "install",
          "--prefix",
          projectDir,
          "--cache",
          npmCacheDir,
          corePackageTarPath,
        ]),
      );

      const tableFilePath = path.join(projectDir, "definitions", "example_table.sqlx");
      fs.ensureFileSync(tableFilePath);
      fs.writeFileSync(
        tableFilePath,
        `
config { type: "table" }
SELECT 1 as id
`,
      );
    });

    test("--default-reservation flag is applied to projectConfig in compile output", async () => {
      const compileResult = await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "compile",
          projectDir,
          "--json",
          `--default-reservation=${DEFAULT_RESERVATION}`,
        ]),
      );

      expect(compileResult.exitCode).equals(0);
      const compiledGraph = JSON.parse(compileResult.stdout);
      expect(compiledGraph.projectConfig).deep.equals({
        warehouse: "bigquery",
        defaultSchema: "sqlanvil",
        assertionSchema: "sqlanvil_assertions",
        defaultDatabase: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        defaultReservation: DEFAULT_RESERVATION,
      });
    });

    test("--default-reservation flag is applied to projectConfig in run --build-only output", async () => {
      const runResult = await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "run",
          projectDir,
          "--credentials",
          CREDENTIALS_PATH,
          "--build-only",
          "--json",
          `--default-reservation=${DEFAULT_RESERVATION}`,
          "--actions=example_table",
        ]),
      );

      expect(runResult.exitCode).equals(0);
      const executionGraph = JSON.parse(runResult.stdout);
      expect(executionGraph.projectConfig).deep.equals({
        warehouse: "bigquery",
        defaultSchema: "sqlanvil",
        assertionSchema: "sqlanvil_assertions",
        defaultDatabase: DEFAULT_DATABASE,
        defaultLocation: DEFAULT_LOCATION,
        defaultReservation: DEFAULT_RESERVATION,
      });
    });
  });

  test("golden with successful unit test", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const packageJsonPath = path.join(projectDir, "package.json");

    // Initialize a project using the CLI, don't install packages.
    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        DEFAULT_DATABASE,
        DEFAULT_LOCATION,
        "--warehouse",
        "bigquery",
        "--bare",
      ]),
    );

    // Install packages manually to get around bazel read-only sandbox issues.
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
    );
    delete workflowSettings.sqlanvilCoreVersion;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
    fs.writeFileSync(
      packageJsonPath,
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
    );
    await getProcessResult(
      execFile(npmPath, [
        "install",
        "--prefix",
        projectDir,
        "--cache",
        npmCacheDir,
        corePackageTarPath,
      ]),
    );

    // Write a simple file to the project.
    const filePath = path.join(projectDir, "definitions", "example.sqlx");
    fs.ensureFileSync(filePath);
    fs.writeFileSync(
      filePath,
      `
config { type: "table" }
select 1
`,
    );
    // Write a simple test to the project.
    const unitTestPath = path.join(projectDir, "definitions", "example_test.sqlx");
    fs.ensureFileSync(unitTestPath);
    fs.writeFileSync(
      unitTestPath,
      `
config { type: "test", dataset: "example" }
select 1
`,
    );

    // Run tests using the CLI.
    const testResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "test",
        projectDir,
        "--credentials",
        CREDENTIALS_PATH,
        "--json",
      ]),
    );

    expect(testResult.exitCode).equals(0);

    expect(JSON.parse(testResult.stdout)).deep.equals([
      {
        name: "example_test",
        successful: true,
      },
    ]);
  });

  test("golden with failed unit test", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const packageJsonPath = path.join(projectDir, "package.json");

    // Initialize a project using the CLI, don't install packages.
    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        DEFAULT_DATABASE,
        DEFAULT_LOCATION,
        "--warehouse",
        "bigquery",
        "--bare",
      ]),
    );

    // Install packages manually to get around bazel read-only sandbox issues.
    const workflowSettings = sqlanvil.WorkflowSettings.create(
      loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
    );
    delete workflowSettings.sqlanvilCoreVersion;
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
    fs.writeFileSync(
      packageJsonPath,
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
    );
    await getProcessResult(
      execFile(npmPath, [
        "install",
        "--prefix",
        projectDir,
        "--cache",
        npmCacheDir,
        corePackageTarPath,
      ]),
    );

    // Write a simple file to the project.
    const filePath = path.join(projectDir, "definitions", "example.sqlx");
    fs.ensureFileSync(filePath);
    fs.writeFileSync(
      filePath,
      `
config { type: "table" }
select 1
`,
    );
    // Write a simple test to the project.
    const unitTestPath = path.join(projectDir, "definitions", "example_test.sqlx");
    fs.ensureFileSync(unitTestPath);
    fs.writeFileSync(
      unitTestPath,
      `
config { type: "test", dataset: "example" }
select 2
`,
    );

    // Run tests using the CLI.
    const testResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "test",
        projectDir,
        "--credentials",
        CREDENTIALS_PATH,
        "--json",
      ]),
    );

    expect(testResult.exitCode).equals(1);

    expect(JSON.parse(testResult.stdout)).deep.equals([
      {
        name: "example_test",
        successful: false,
        messages: ['For row 0 and column "f0_": expected "2", but saw "1".'],
      },
    ]);
  });

  suite("onSchemaChange", ({ beforeEach }) => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const uniqueDataset = `sqlanvil_e2e_osc_${Math.random().toString(36).substring(7)}`;

    beforeEach("setup test project", async () => {
      const npmCacheDir = tmpDirFixture.createNewTmpDir();
      const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
      const packageJsonPath = path.join(projectDir, "package.json");

      await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "init",
          projectDir,
          DEFAULT_DATABASE,
          DEFAULT_LOCATION,
          "--warehouse",
          "bigquery",
          "--bare",
        ]),
      );

      const workflowSettings = sqlanvil.WorkflowSettings.create(
        loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
      );
      delete workflowSettings.sqlanvilCoreVersion;
      workflowSettings.defaultDataset = uniqueDataset;
      fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));

      fs.writeFileSync(
        packageJsonPath,
        `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
      );
      await getProcessResult(
        execFile(npmPath, [
          "install",
          "--prefix",
          projectDir,
          "--cache",
          npmCacheDir,
          corePackageTarPath,
        ]),
      );

      fs.ensureFileSync(path.join(projectDir, "definitions", "setup_table.sqlx"));
      fs.writeFileSync(
        path.join(projectDir, "definitions", "setup_table.sqlx"),
        `
config { 
  type: "operations"
}
CREATE OR REPLACE TABLE \`\${sqlanvil.projectConfig.defaultDatabase}.\${sqlanvil.projectConfig.defaultSchema}.example_incremental\` AS SELECT 1 AS id, 'old' AS field1
`,
      );

      fs.ensureFileSync(path.join(projectDir, "definitions", "example_incremental.sqlx"));
      fs.writeFileSync(
        path.join(projectDir, "definitions", "example_incremental.sqlx"),
        `
config { 
  type: "incremental",
  onSchemaChange: "EXTEND"
}
SELECT 1 as id, 'new' as field1, 'new2' as field2
`,
      );

      fs.ensureFileSync(path.join(projectDir, "definitions", "teardown_schema.sqlx"));
      fs.writeFileSync(
        path.join(projectDir, "definitions", "teardown_schema.sqlx"),
        `
config { 
  type: "operations"
}
DROP SCHEMA IF EXISTS \`\${sqlanvil.projectConfig.defaultDatabase}.\${sqlanvil.projectConfig.defaultSchema}\` CASCADE
`,
      );
    });

    test(
      "generates dynamic SQL for EXTEND when table exists in BigQuery",
      { timeout: 120000 },
      async () => {
        try {
          // Run setup operation to create the table in BigQuery.
          // sqlanvil will automatically create the uniqueDataset schema.
          await getProcessResult(
            execFile(nodePath, [
              cliEntryPointPath,
              "run",
              projectDir,
              "--credentials",
              CREDENTIALS_PATH,
              "--actions=setup_table",
            ]),
          );

          // Run the incremental table in dry-run mode.
          // sqlanvil will detect the table exists and generate the dynamic procedural SQL.
          const runResult = await getProcessResult(
            execFile(nodePath, [
              cliEntryPointPath,
              "run",
              projectDir,
              "--credentials",
              CREDENTIALS_PATH,
              "--build-only",
              "--json",
              "--actions=example_incremental",
            ]),
          );

          expect(runResult.exitCode).equals(0);
          const executionGraph = JSON.parse(runResult.stdout);
          const statement = executionGraph.actions[0].tasks[0].statement;

          const expectedRunResult = {
            projectConfig: {
              warehouse: "bigquery",
              defaultSchema: uniqueDataset,
              assertionSchema: "sqlanvil_assertions",
              defaultDatabase: DEFAULT_DATABASE,
              defaultLocation: DEFAULT_LOCATION,
            },
            runConfig: {
              actions: ["example_incremental"],
              fullRefresh: false,
            },
            actions: [
              {
                fileName: "definitions/example_incremental.sqlx",
                hermeticity: "NON_HERMETIC",
                tableType: "incremental",
                target: {
                  database: DEFAULT_DATABASE,
                  name: "example_incremental",
                  schema: uniqueDataset,
                },
                tasks: [
                  {
                    statement,
                    type: "statement",
                  },
                ],
                type: "table",
              },
            ],
            warehouseState: executionGraph.warehouseState,
          };

          expect(executionGraph).deep.equals(expectedRunResult);
          expect(statement).to.include("CREATE OR REPLACE PROCEDURE");
          expect(statement).to.include(
            "Column removals are not allowed when on_schema_change = 'EXTEND'.",
          );
          expect(statement).to.include("ALTER TABLE");
          expect(statement).to.include("ADD COLUMN IF NOT EXISTS");
        } finally {
          // Teardown the schema completely, regardless of test success or failure.
          await getProcessResult(
            execFile(nodePath, [
              cliEntryPointPath,
              "run",
              projectDir,
              "--credentials",
              CREDENTIALS_PATH,
              "--actions=teardown_schema",
            ]),
          );
        }
      },
    );
  });

  suite("json output", ({ beforeEach, after }) => {
    const uniqueDataset = `sqlanvil_e2e_json_${Math.random().toString(36).substring(7)}`;
    let projectDir: string;

    const runCli = (args: string[]) =>
      getProcessResult(execFile(nodePath, [cliEntryPointPath, "run", projectDir, ...args]));

    const writeDefinition = (name: string, contents: string) => {
      fs.ensureFileSync(path.join(projectDir, "definitions", name));
      fs.writeFileSync(path.join(projectDir, "definitions", name), contents);
    };

    beforeEach("setup test project", async () => {
      projectDir = tmpDirFixture.createNewTmpDir();
      const npmCacheDir = tmpDirFixture.createNewTmpDir();
      const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
      await getProcessResult(
        execFile(nodePath, [
          cliEntryPointPath,
          "init",
          projectDir,
          DEFAULT_DATABASE,
          DEFAULT_LOCATION,
          "--warehouse",
          "bigquery",
          "--bare",
        ]),
      );
      const workflowSettings = sqlanvil.WorkflowSettings.create(
        loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
      );
      delete workflowSettings.sqlanvilCoreVersion;
      workflowSettings.defaultDataset = uniqueDataset;
      fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        `{ "dependencies": { "@sqlanvil/core": "${version}" } }`,
      );
      await getProcessResult(
        execFile(npmPath, [
          "install",
          "--prefix",
          projectDir,
          "--cache",
          npmCacheDir,
          corePackageTarPath,
        ]),
      );
      writeDefinition("example_table.sqlx", `config { type: "table" }\nSELECT 1 AS id\n`);
      writeDefinition(
        "teardown_schema.sqlx",
        `config { type: "operations" }
DROP SCHEMA IF EXISTS \`\${sqlanvil.projectConfig.defaultDatabase}.\${sqlanvil.projectConfig.defaultSchema}\` CASCADE
`,
      );
    });

    after("drop the test dataset", async () => {
      if (projectDir) {
        await runCli(["--credentials", CREDENTIALS_PATH, "--actions=teardown_schema"]);
      }
    });

    test("run --dry-run --json outputs a RunResult", { timeout: 120000 }, async () => {
      const result = await runCli([
        "--credentials",
        CREDENTIALS_PATH,
        "--dry-run",
        "--json",
        "--actions=example_table",
      ]);

      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      expect(parsed.actions).to.have.lengthOf(1);
      expect(parsed.actions[0].target).deep.equals({
        database: DEFAULT_DATABASE,
        schema: uniqueDataset,
        name: "example_table",
      });
      expect(parsed.actions[0].status).equals(sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL);
      expect(parsed.actions[0].tasks).to.have.lengthOf(1);
      expect(parsed.actions[0].tasks[0].status).equals(
        sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL,
      );
    });

    test("run --json executes actions and outputs a RunResult", { timeout: 120000 }, async () => {
      const result = await runCli([
        "--credentials",
        CREDENTIALS_PATH,
        "--json",
        "--actions=example_table",
      ]);

      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      expect(parsed.actions).to.have.lengthOf(1);
      expect(parsed.actions[0].status).equals(sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL);
      expect(parsed.actions[0].tasks[0].metadata?.bigquery?.jobId)
        .to.be.a("string")
        .and.not.equal("");
    });

    test(
      "run --build-only without --json prints the warehouse state",
      { timeout: 120000 },
      async () => {
        writeDefinition("new_table.sqlx", `config { type: "table" }\nSELECT 1 AS id\n`);
        // Create example_table as a table, then make it a view locally.
        const created = await runCli([
          "--credentials",
          CREDENTIALS_PATH,
          "--actions=example_table",
        ]);
        expect(created.exitCode, created.stderr).equals(0);
        writeDefinition("example_table.sqlx", `config { type: "view" }\nSELECT 1 AS id\n`);

        const result = await runCli([
          "--credentials",
          CREDENTIALS_PATH,
          "--build-only",
          "--actions=example_table,new_table",
        ]);

        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
        expect(result.stdout).to.include("2 dataset(s):");
        expect(result.stdout).to.match(
          new RegExp(
            `${uniqueDataset}\\.example_table.*\\[view\\] \\(type: table -> view, last modified: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} UTC\\)`,
          ),
        );
        expect(result.stdout).to.match(
          new RegExp(`${uniqueDataset}\\.new_table.*\\[table\\] \\(does not exist\\)`),
        );
      },
    );

    test("run --build-only notes that --dry-run and --run-tests are ignored", async () => {
      const result = await runCli([
        "--credentials",
        CREDENTIALS_PATH,
        "--build-only",
        "--dry-run",
        "--run-tests",
        "--json",
        "--actions=example_table",
      ]);

      expect(result.exitCode, result.stderr).equals(0);
      expect(JSON.parse(result.stdout).actions).to.have.lengthOf(1);
      expect(result.stderr).to.include("--dry-run is ignored because --build-only is set");
      expect(result.stderr).to.include("--run-tests is ignored because --build-only is set");
    });

    test("run --json with no matching actions outputs an empty RunResult", async () => {
      const result = await runCli([
        "--credentials",
        CREDENTIALS_PATH,
        "--json",
        "--actions=nonexistent_action",
      ]);

      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
      expect(parsed.actions).deep.equals([]);
    });

    test(
      "run --dry-run --json --run-tests keeps stdout valid JSON when tests pass",
      { timeout: 120000 },
      async () => {
        writeDefinition(
          "passing_test.sqlx",
          `config { type: "test", dataset: "example_table" }\nSELECT 1 AS id\n`,
        );

        const result = await runCli([
          "--credentials",
          CREDENTIALS_PATH,
          "--dry-run",
          "--json",
          "--run-tests",
          "--actions=example_table",
        ]);

        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.status).equals(sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL);
        expect(parsed.actions).to.have.lengthOf(1);
      },
    );

    test(
      "run --dry-run --json --run-tests writes failed test details to stderr only",
      { timeout: 120000 },
      async () => {
        writeDefinition(
          "failing_test.sqlx",
          `config { type: "test", dataset: "example_table" }\nSELECT 2 AS id\n`,
        );

        const result = await runCli([
          "--credentials",
          CREDENTIALS_PATH,
          "--dry-run",
          "--json",
          "--run-tests",
          "--actions=example_table",
        ]);

        expect(result.exitCode).equals(1);
        expect(result.stdout).equals("");
        expect(result.stderr).to.include("failing_test: failed");
        expect(result.stderr).to.include("Unit tests did not pass; aborting run.");
      },
    );

    test(
      "warns when SET @@dataset_id is used and no location is configured",
      { timeout: 120000 },
      async () => {
        const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
        const workflowSettings = sqlanvil.WorkflowSettings.create(
          loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")),
        );
        delete workflowSettings.defaultLocation;
        fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
        const credentialsWithoutLocation = path.join(projectDir, ".df-credentials.json");
        const { location, ...rest } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
        fs.writeFileSync(credentialsWithoutLocation, JSON.stringify(rest));
        writeDefinition(
          "sets_dataset.sqlx",
          `config { type: "operations" }\nSET @@dataset_id = 'sqlanvil';\nSELECT 1 AS id\n`,
        );

        const result = await runCli([
          "--credentials",
          credentialsWithoutLocation,
          "--dry-run",
          "--actions=sets_dataset",
        ]);

        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).equals(0);
        expect(result.stderr).to.include(
          "Warning: SET @@dataset_id is used without a configured location.",
        );
        expect(result.stderr, JSON.stringify(result.stderr)).to.include(
          `Affected actions: ${DEFAULT_DATABASE}.${uniqueDataset}.sets_dataset`,
        );
      },
    );
  });
});
