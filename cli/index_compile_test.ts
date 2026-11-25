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

  // The test below exercises the stateless-install path against a SPECIFIC published
  // @sqlanvil/core version fetched from the public npm registry, so it needs network
  // and a real `npm install`. It is gated off by default to keep //cli:tests hermetic;
  // set SA_TEST_PUBLISHED_CORE=1 (via --test_env) to run it. The version-compatibility
  // rules themselves are unit-tested without npm in cli/vm/compile_test.ts.
  const runPublishedCoreTests = !!process.env.SA_TEST_PUBLISHED_CORE;

  test(
    "compile throws an error when sqlanvilCoreVersion not in workflow_settings.yaml and no " +
      "package.json exists",
    async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(sqlanvil.WorkflowSettings.create({ defaultProject: "sqlanvil" })),
      );

      expect(
        (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
          .stderr,
      ).contains(
        "sqlanvilCoreVersion must be specified either in workflow_settings.yaml or via a " +
          "package.json",
      );
    },
  );

  test("compile error when package.json and no package is installed", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
    );
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: tada-analytics
defaultDataset: sa_integration_test
defaultAssertionDataset: sa_integration_test_assertions
defaultLocation: "${DEFAULT_LOCATION}"
`,
    );

    expect(
      (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
        .stderr,
    ).contains(
      "Could not find a recent installed version of @sqlanvil/core in the project. Check that " +
        "either `sqlanvilCoreVersion` is specified in `workflow_settings.yaml`, or " +
        "`@sqlanvil/core` is specified in `package.json`. If using `package.json`, then run " +
        "`sqlanvil install`.",
    );
  });

  if (runPublishedCoreTests) {
    // MIN_SUPPORTED_CORE_VERSION (cli/vm/compile.ts) is the oldest core the CLI accepts, so
    // it must keep compiling a real project as the CLI version moves on. There is no
    // published @sqlanvil/core outside major 1 to exercise rejection end to end (0.0.1 is an
    // empty placeholder with no bundle); the unit tests cover that path.
    test("compile succeeds with @sqlanvil/core 1.0.0 (MIN_SUPPORTED_CORE_VERSION)", async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      // sqlanvilCoreVersion in workflow_settings.yaml triggers the stateless install path
      // (compile.ts copies to a tmp dir and runs `npm i`), so this is the flow real users hit.
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml({
          defaultProject: DEFAULT_DATABASE,
          defaultLocation: DEFAULT_LOCATION,
          defaultDataset: "dataform",
          sqlanvilCoreVersion: "1.0.0",
        }),
      );
      fs.ensureFileSync(path.join(projectDir, "definitions", "example.sqlx"));
      fs.writeFileSync(
        path.join(projectDir, "definitions", "example.sqlx"),
        `config { type: "table" }\nSELECT 1 AS id`,
      );

      // npm needs a writable cache; ~/.npm is read-only in the bazel sandbox.
      const npmCacheDir = tmpDirFixture.createNewTmpDir();
      const result = await getProcessResult(
        execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"], {
          env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir },
        }),
      );

      expect(result.exitCode, `compile failed: ${result.stderr}`).equals(0);
      const compiled = JSON.parse(result.stdout);
      expect(compiled.tables).to.have.lengthOf(1);
      expect(compiled.tables[0].fileName).equals("definitions/example.sqlx");
    });

    // Upstream #2272 (3.1.4): the stateless-install copy skips what .gitignore / .sqlanvilignore
    // exclude outside definitions/ and includes/. Pinned to a published core so `npm i` succeeds.
    suite("stateless-install project copy", () => {
      function setUpStatelessProject() {
        const projectDir = tmpDirFixture.createNewTmpDir();
        fs.writeFileSync(
          path.join(projectDir, "workflow_settings.yaml"),
          dumpYaml({
            defaultProject: DEFAULT_DATABASE,
            defaultLocation: DEFAULT_LOCATION,
            defaultDataset: "dataform",
            sqlanvilCoreVersion: "1.37.2",
          }),
        );
        // npm needs a writable cache; ~/.npm is read-only in the bazel sandbox.
        const env = { ...process.env, NPM_CONFIG_CACHE: tmpDirFixture.createNewTmpDir() };
        const compileProject = (args = ["--json"]) =>
          getProcessResult(
            execFile(nodePath, [cliEntryPointPath, "compile", projectDir, ...args], { env }),
          );
        return { projectDir, compileProject };
      }

      test(
        "compiles inputs that definitions/ and includes/ reach through symlinks into gitignored paths",
        { timeout: 60000 },
        async () => {
          const { projectDir, compileProject } = setUpStatelessProject();
          fs.writeFileSync(path.join(projectDir, ".gitignore"), "generated/\n");
          fs.ensureDirSync(path.join(projectDir, "generated", "definitions", "nested"));
          fs.writeFileSync(
            path.join(projectDir, "generated", "definitions", "table.sqlx"),
            `config { type: "table" }\nSELECT "\${constants.VALUE}" AS id`,
          );
          fs.writeFileSync(
            path.join(projectDir, "generated", "definitions", "nested", "other_table.sqlx"),
            `config { type: "table" }\nSELECT 2 AS id`,
          );
          fs.ensureDirSync(path.join(projectDir, "generated", "includes"));
          fs.writeFileSync(
            path.join(projectDir, "generated", "includes", "constants.js"),
            `module.exports = { VALUE: "from_include" };`,
          );
          fs.symlinkSync(
            path.join("generated", "definitions"),
            path.join(projectDir, "definitions"),
          );
          fs.ensureDirSync(path.join(projectDir, "includes"));
          fs.symlinkSync(
            path.join("..", "generated", "includes", "constants.js"),
            path.join(projectDir, "includes", "constants.js"),
          );

          const result = await compileProject();

          expect(result.exitCode, `compile failed: ${result.stderr}`).equals(0);
          const tables: sqlanvil.ITable[] = JSON.parse(result.stdout).tables ?? [];
          expect(tables.map((table) => table.target.name).sort()).deep.equals([
            "other_table",
            "table",
          ]);
          expect(tables.find((table) => table.target.name === "table").query).contains(
            "from_include",
          );
        },
      );

      test(
        "explains a gitignored file actions.yaml references, removes the copy, and compiles it once re-included",
        { timeout: 60000 },
        async () => {
          const { projectDir, compileProject } = setUpStatelessProject();
          fs.writeFileSync(path.join(projectDir, ".gitignore"), "queries/\n");
          fs.ensureDirSync(path.join(projectDir, "definitions"));
          fs.writeFileSync(
            path.join(projectDir, "definitions", "actions.yaml"),
            dumpYaml({
              actions: [{ table: { name: "example", filename: "../queries/example.sql" } }],
            }),
          );
          fs.ensureDirSync(path.join(projectDir, "queries"));
          fs.writeFileSync(path.join(projectDir, "queries", "example.sql"), "SELECT 1 AS id");
          const excludedResult = await compileProject(["--json", "--verbose"]);

          expect(excludedResult.exitCode).not.equals(0);
          expect(excludedResult.stderr).contains(
            "'queries' is in the project but not in the copy compiled for sqlanvilCoreVersion",
          );
          const copyPath = /Copying project to temporary directory: (.+)/.exec(
            excludedResult.stdout + excludedResult.stderr,
          )?.[1];
          expect(copyPath, excludedResult.stderr).to.not.equal(undefined);
          expect(fs.existsSync(copyPath)).equals(false);

          fs.writeFileSync(path.join(projectDir, ".sqlanvilignore"), "!/queries/\n");
          const result = await compileProject();

          expect(result.exitCode, `compile failed: ${result.stderr}`).equals(0);
          const tables: sqlanvil.ITable[] = JSON.parse(result.stdout).tables ?? [];
          expect(tables.map((table) => table.query.trim())).deep.equals(["SELECT 1 AS id"]);
        },
      );
    });
  } // end runPublishedCoreTests gate

  ["package.json", "package-lock.json", "node_modules"].forEach((npmFile) => {
    test(`compile throws an error when sqlanvilCoreVersion in workflow_settings.yaml and ${npmFile} is present`, async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml(
          sqlanvil.WorkflowSettings.create({
            defaultProject: "sqlanvil",
            sqlanvilCoreVersion: "3.0.0",
          }),
        ),
      );
      const resolvedNpmPath = path.join(projectDir, npmFile);
      if (npmFile === "node_modules") {
        fs.mkdirSync(resolvedNpmPath);
      } else {
        fs.writeFileSync(resolvedNpmPath, "");
      }

      expect(
        (await getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", projectDir])))
          .stderr,
      ).contains(`${npmFile}' unexpected; remove it and try again`);
    });
  });

  // Upstream #2448: the pinned version is written into a temporary package.json and handed to
  // `npm i`, so anything that isn't an exact semantic version is rejected before the temporary
  // directory exists or npm runs.
  for (const { label, yamlLine } of [
    { label: "file tarball specifier", yamlLine: 'sqlanvilCoreVersion: "file:./custom-core.tgz"' },
    {
      label: "HTTPS tarball URL",
      yamlLine: 'sqlanvilCoreVersion: "https://example.invalid/core.tgz"',
    },
    {
      label: "git URL specifier",
      yamlLine: 'sqlanvilCoreVersion: "git+https://example.invalid/repo.git"',
    },
    { label: "npm alias specifier", yamlLine: 'sqlanvilCoreVersion: "npm:semver@7.5.4"' },
    { label: "semver range", yamlLine: 'sqlanvilCoreVersion: "^3.0.0"' },
    { label: "malformed dot prerelease", yamlLine: 'sqlanvilCoreVersion: "3.0.0-."' },
    { label: "leading zero version", yamlLine: 'sqlanvilCoreVersion: "03.0.0"' },
    { label: "non-string YAML array", yamlLine: 'sqlanvilCoreVersion: ["3.0.0"]' },
  ]) {
    test(`compile rejects ${label} before creating a temporary environment or invoking npm`, async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        `defaultProject: sqlanvil\n${yamlLine}\n`,
      );
      const missingTmpDir = path.join(tmpDirFixture.createNewTmpDir(), "must-not-be-used");
      const fakeBinDir = tmpDirFixture.createNewTmpDir();
      const npmCalledFile = path.join(tmpDirFixture.createNewTmpDir(), "npm-called");
      fs.writeFileSync(path.join(fakeBinDir, "npm"), `#!/bin/sh\ntouch "${npmCalledFile}"\nexit 1\n`, {
        mode: 0o755,
      });

      const result = await getProcessResult(
        execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--verbose"], {
          env: {
            ...process.env,
            TMPDIR: missingTmpDir,
            TEMP: missingTmpDir,
            TMP: missingTmpDir,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
          },
        }),
      );

      expect(result.exitCode).equals(1);
      expect(result.stderr).contains("Invalid sqlanvilCoreVersion");
      expect(result.stderr).contains("must be a valid semantic version");
      expect(result.stderr).not.contains("Using isolated environment");
      expect(fs.existsSync(npmCalledFile)).equals(false);
      expect(fs.existsSync(missingTmpDir)).equals(false);
    });
  }
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
        DEFAULT_LOCATION,
        // The suite deep-equals compile output, so keep the 1.21+ sample project out.
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
          schema: "sqlanvil_assertions",
        },
        dependencyTargets: [
          {
            database: DEFAULT_DATABASE,
            name: "example_table",
            schema: "sqlanvil",
          },
        ],
        disabled: true,
        fileName: "definitions/example_table.sqlx",
        parentAction: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil",
        },
        query:
          // tslint:disable-next-line:tsr-detect-sql-literal-injection
          `\nSELECT\n  *\nFROM (\n  SELECT\n    id,\n    COUNT(1) AS index_row_count\n  FROM \`${DEFAULT_DATABASE}.sqlanvil.example_table\`\n  GROUP BY id\n  ) AS data\nWHERE index_row_count > 1\n`,
        target: {
          database: DEFAULT_DATABASE,
          name: "sqlanvil_example_table_assertions_uniqueKey_0",
          schema: "sqlanvil_assertions",
        },
      },
      {
        canonicalTarget: {
          database: DEFAULT_DATABASE,
          name: "test_assertion",
          schema: "sqlanvil_assertions",
        },
        disabled: true,
        fileName: "definitions/test_assertion.sqlx",
        query: "\n\nSELECT 1 WHERE FALSE\n",
        target: {
          database: DEFAULT_DATABASE,
          name: "test_assertion",
          schema: "sqlanvil_assertions",
        },
      },
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
      warehouse: "bigquery",
    },
    tables: [
      {
        canonicalTarget: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil",
        },
        disabled: false,
        enumType: "TABLE",
        fileName: "definitions/example_table.sqlx",
        hermeticity: "NON_HERMETIC",
        query: "\n\nSELECT 1 as id\n",
        target: {
          database: DEFAULT_DATABASE,
          name: "example_table",
          schema: "sqlanvil",
        },
        type: "table",
      },
    ],
    targets: [
      {
        database: DEFAULT_DATABASE,
        name: "sqlanvil_example_table_assertions_uniqueKey_0",
        schema: "sqlanvil_assertions",
      },
      {
        database: DEFAULT_DATABASE,
        name: "example_table",
        schema: "sqlanvil",
      },
      {
        database: DEFAULT_DATABASE,
        name: "test_assertion",
        schema: "sqlanvil_assertions",
      },
    ],
  };

  test("with --disable-assertions flag", async () => {
    await setUpWorkflowSettings(false);

    const compileResult = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--json",
        "--disable-assertions",
      ]),
    );

    expect(compileResult.exitCode).equals(0);
    expect(JSON.parse(compileResult.stdout)).deep.equals(expectedCompileResult);
  });

  test("with disableAssertions set in workflow_settings.yaml", async () => {
    await setUpWorkflowSettings(true);

    const compileResult = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"]),
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
        DEFAULT_LOCATION,
        // The selection assertions expect ONLY the three tables below — no sample project.
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
      path.join(projectDir, "package.json"),
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
    JSON.parse(stdout)
      .tables.map((table: any) => table.target.name)
      .sort();

  test("no selector emits the entire graph", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["downstream", "midstream", "upstream"]);
  });

  test("--actions filters output to the selected action", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "compile",
        projectDir,
        "--actions",
        "midstream",
        "--json",
      ]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["midstream"]);
  });

  // Upstream #2435.
  const compileCli = (...args: string[]) =>
    getProcessResult(execFile(nodePath, [cliEntryPointPath, "compile", ...args]));

  test("--mermaid prints a flowchart of the selected graph", async () => {
    const projectDir = await setupSelectionProject();
    const result = await compileCli(projectDir, "--actions", "midstream", "--include-deps", "--mermaid");
    expect(result.exitCode, result.stderr).equals(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).equals("graph LR");
    const nodeLine = (name: string) => lines.find((line) => line.endsWith(`.${name} [table]"]`));
    const idOf = (name: string) => nodeLine(name)?.trim().split("[")[0];
    expect(idOf("upstream")).to.match(/^n[0-9a-f]{8}$/);
    expect(idOf("midstream")).to.match(/^n[0-9a-f]{8}$/);
    // Sorted by target, so midstream comes before upstream.
    expect(lines.indexOf(nodeLine("midstream"))).lessThan(lines.indexOf(nodeLine("upstream")));
    expect(lines.filter((line) => line.includes("-->"))).deep.equals([
      `  ${idOf("upstream")} --> ${idOf("midstream")}`,
    ]);
  });

  test("--mermaid shows dependencies outside the selection as plain nodes", async () => {
    const projectDir = await setupSelectionProject();
    const result = await compileCli(projectDir, "--actions", "midstream", "--mermaid");
    expect(result.exitCode, result.stderr).equals(0);
    const nodeLines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes('["'));
    expect(nodeLines.map((line) => line.replace(/^.*\["[^.]*\./, ""))).deep.equals([
      'midstream [table]"]',
      'upstream"]',
    ]);
  });

  test("--mermaid warns on stderr when the diagram is too large to render", async () => {
    const projectDir = await setupSelectionProject();
    fs.writeFileSync(
      path.join(projectDir, "definitions", "chain.js"),
      `for (let i = 1; i <= 501; i++) {
        operate("c" + i).dependencies(["c" + (i - 1)]).queries("SELECT 1");
      }
      operate("c0").queries("SELECT 1");`,
    );
    const result = await compileCli(projectDir, "--mermaid");
    expect(result.exitCode, result.stderr).equals(0);
    expect(result.stdout.startsWith("graph LR\n")).equals(true);
    expect(result.stdout).not.contains("Warning");
    expect(result.stdout.split("\n").filter((line) => line.includes(" --> ")).length).equals(503);
    expect(result.stderr).contains("Warning: this diagram has 503 edges");
  });

  test("--mermaid prints no warning for a diagram within the limits", async () => {
    const projectDir = await setupSelectionProject();
    const result = await compileCli(projectDir, "--mermaid");
    expect(result.exitCode, result.stderr).equals(0);
    expect(result.stderr).not.contains("Warning");
  });

  test("--mermaid cannot be combined with --json or --dot", async () => {
    const projectDir = await setupSelectionProject();
    for (const other of ["--json", "--dot"]) {
      const result = await compileCli(projectDir, "--mermaid", other);
      expect(result.exitCode).not.equals(0);
      expect(result.stderr).contains("mutually exclusive");
    }
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
        "--json",
      ]),
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
        "--json",
      ]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["downstream", "midstream"]);
  });

  test("--tags filters output to actions carrying the tag", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--tags", "daily", "--json"]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals(["upstream"]);
  });

  test("selector matching nothing emits an empty graph and exits zero", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--actions", "nope", "--json"]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(tableNames(result.stdout)).deep.equals([]);
  });

  test("--include-deps without a selector is rejected", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--include-deps", "--json"]),
    );
    expect(result.exitCode).not.equals(0);
    expect(result.stderr).contains("--include-deps");
  });

  test("artifacts are written by default", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json"]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(fs.existsSync(path.join(projectDir, "target", "catalog"))).equals(true);
  });

  // --no-artifacts was declared as an option literally named "no-artifacts", which yargs read as
  // a negation of an undeclared "artifacts" and rejected in strict mode, so the documented flag
  // never worked (broken at least since 1.32.4).
  test("--no-artifacts is accepted and skips writing target/", async () => {
    const projectDir = await setupSelectionProject();
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--json", "--no-artifacts"]),
    );
    expect(result.exitCode, result.stderr).equals(0);
    expect(result.stderr).does.not.contain("Unknown argument");
    expect(tableNames(result.stdout)).deep.equals(["downstream", "midstream", "upstream"]);
    expect(fs.existsSync(path.join(projectDir, "target"))).equals(false);
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
      }),
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.mkdirSync(path.join(projectDir, "includes"));

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
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

    const compileResult = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir]),
    );

    expect(compileResult.exitCode).equals(0);
    expect(compileResult.stdout).contains("Compiled 0 action(s).");
  });

  test("compile --environment with an unknown environment fails fast", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({
        warehouse: "postgres",
        defaultDataset: "analytics",
        sqlanvilCoreVersion: "3.0.0",
        environments: { dev: { schemaSuffix: "dev" } },
      }),
    );
    const result = await getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "compile", projectDir, "--environment", "nope"]),
    );
    expect(result.exitCode).to.not.equal(0);
    expect(result.stderr).to.contain('Environment "nope" not found');
    expect(result.stderr).to.contain("dev");
  });

  test(
    "compile --environment applies the env's schemaSuffix + vars; CLI flag overrides",
    { timeout: 120000 },
    async () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      const npmCacheDir = tmpDirFixture.createNewTmpDir();

      // No sqlanvilCoreVersion → uses the locally installed core (below), not the
      // stateless npm-registry fetch. environments: defines a `dev` env.
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        dumpYaml({
          defaultProject: DEFAULT_DATABASE,
          defaultLocation: DEFAULT_LOCATION,
          defaultDataset: "sqlanvil",
          environments: {
            dev: { schemaSuffix: "dev_env", vars: { greeting: "hello" } },
          },
        }),
      );
      fs.writeFileSync(
        path.join(projectDir, "package.json"),
        `{
  "dependencies":{
    "@sqlanvil/core": "${version}"
  }
}`,
      );
      // Install the local core tarball (avoids bazel read-only sandbox + network).
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

      const filePath = path.join(projectDir, "definitions", "example.sqlx");
      fs.ensureFileSync(filePath);
      fs.writeFileSync(
        filePath,
        `config { type: "table" }\nselect 1 as \${sqlanvil.projectConfig.vars.greeting}`,
      );

      // --environment dev: env's schemaSuffix + vars apply.
      const envResult = await getProcessResult(
        execFile(
          nodePath,
          [cliEntryPointPath, "compile", projectDir, "--environment", "dev", "--json"],
          {
            env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir },
          },
        ),
      );
      expect(envResult.exitCode, `compile failed: ${envResult.stderr}`).equals(0);
      const envCompiled = JSON.parse(envResult.stdout);
      expect(envCompiled.tables[0].target.schema).equals("sqlanvil_dev_env");
      expect(envCompiled.tables[0].query).contains("hello");

      // --environment dev --schema-suffix qa: explicit CLI flag overrides the env.
      const overrideResult = await getProcessResult(
        execFile(
          nodePath,
          [
            cliEntryPointPath,
            "compile",
            projectDir,
            "--environment",
            "dev",
            "--schema-suffix",
            "qa",
            "--json",
          ],
          { env: { ...process.env, NPM_CONFIG_CACHE: npmCacheDir } },
        ),
      );
      expect(overrideResult.exitCode, `compile failed: ${overrideResult.stderr}`).equals(0);
      const overrideCompiled = JSON.parse(overrideResult.stdout);
      expect(overrideCompiled.tables[0].target.schema).equals("sqlanvil_qa");
      // Env vars still apply (CLI --schema-suffix doesn't touch vars).
      expect(overrideCompiled.tables[0].query).contains("hello");
    },
  );
});
