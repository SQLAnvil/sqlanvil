import { expect } from "chai";
import { execFile } from "child_process";

import { cliEntryPointPath } from "sa/cli/index_test_base";
import { getProcessResult, nodePath, suite, test } from "sa/testing";

suite("help command", () => {
  test("shows global help with the help command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("sqlanvil [command]");
    expect(output).to.include("sqlanvil init [project-dir] [default-database] [default-location]");
    expect(output).to.include("sqlanvil install [project-dir]");
    expect(output).to.include("sqlanvil init-creds [project-dir]");
    expect(output).to.include("sqlanvil compile [project-dir]");
    expect(output).to.include("sqlanvil test [project-dir]");
    expect(output).to.include("sqlanvil run [project-dir]");
    expect(output).to.include("sqlanvil format [project-dir]");
  });

  test("shows help for 'init' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "init"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Create a new sqlanvil project");
    expect(output).to.include("--iceberg");
    expect(output).to.include("Initialize the project with workflow-level Iceberg tables configuration.");
  });

  test("shows help for 'install' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "install"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Install a project's NPM dependencies.");
    expect(output).to.include("[project-dir]");
  });

  test("shows help for 'init-creds' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "init-creds"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Create a .df-credentials.json file for sqlanvil to use when accessing BigQuery.");
    expect(output).to.include("[project-dir]");
    expect(output).to.include("--test-connection");
    expect(output).to.include("If true, a test query will be run using your final credentials.");
  });

  test("shows help for 'compile' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "compile"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Compile the sqlanvil project.");
    expect(output).to.include("--watch");
    expect(output).to.include("--json");
    expect(output).to.include("--quiet");
    expect(output).to.include("--actions");
    expect(output).to.include("--tags");
    expect(output).to.include("--include-deps");
    expect(output).to.include("--include-dependents");
    // Compile-specific wording: filters output rather than executing actions.
    expect(output).to.include("include in the output");
  });

  test("shows help for 'test' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "test"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Run the sqlanvil project's unit tests.");
    expect(output).to.include("[project-dir]");
    expect(output).to.include("--credentials");
    expect(output).to.include("--timeout");
    expect(output).to.include("--default-database");
    expect(output).to.include("--schema-suffix");
  });

  test("shows help for 'run' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "run"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Run the sqlanvil project.");
    expect(output).to.include("--dry-run");
    expect(output).to.include("--run-tests");
    expect(output).to.include("--action-retry-limit");
    expect(output).to.include("--actions");
    expect(output).to.include("--full-refresh");
    expect(output).to.include("--include-deps");
    expect(output).to.include("--include-dependents");
    expect(output).to.include("--tags");
    expect(output).to.include("--job-labels");
  });

   test("shows help for 'format' command", async () => {
    const result = await getProcessResult(execFile(nodePath, [cliEntryPointPath, "help", "format"]));
    expect(result.exitCode).equals(0);
    const output = result.stdout;
    expect(output).to.include("Format the sqlanvil project's files.");
    expect(output).to.include("--check");
    expect(output).to.include("Check if files are formatted correctly without modifying them.");
    expect(output).to.include("--actions");
  });
});
