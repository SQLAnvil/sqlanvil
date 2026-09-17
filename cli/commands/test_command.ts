import { compile, credentials, test } from "sa/cli/api";
import { IDbAdapter } from "sa/cli/api/dbadapters";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { MySqlDbAdapter } from "sa/cli/api/dbadapters/mysql";
import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  credentialsOption,
  credentialsPathWithEnvironment,
  jsonOutputOption,
  projectConfigOverrideWithEnvironment,
  projectDirMustExistOption,
  timeoutOption
} from "sa/cli/common_options";
import {
  print,
  printCompiledGraphErrors,
  printError,
  printSuccess,
  printTestResult
} from "sa/cli/console";
import { ProjectConfigArgv, ProjectConfigOptions } from "sa/cli/project_config_options";
import { compiledGraphHasErrors } from "sa/cli/util";
import { ICommand } from "sa/cli/yargswrapper";

interface TestArgv extends ProjectConfigArgv {
  "project-dir": string;
  credentials: string;
  timeout: number | null;
  json: boolean;
  // Read via printCompiledGraphErrors but not declared on `test` (undefined at runtime).
  quiet?: boolean;
}

export const testCommand: ICommand = {
  format: `test [${projectDirMustExistOption.name}]`,
  description: "Run the sqlanvil project's unit tests.",
  positionalOptions: [projectDirMustExistOption],
  options: [
    credentialsOption,
    timeoutOption,
    jsonOutputOption,
    ...ProjectConfigOptions.allYargsOptions
  ],
  processFn: async (argv: TestArgv) => {
    if (!argv[jsonOutputOption.name]) {
      print("Compiling...\n");
    }
    const compiledGraph = await compile({
      projectDir: argv[projectDirMustExistOption.name],
      projectConfigOverride: projectConfigOverrideWithEnvironment(
        argv[projectDirMustExistOption.name],
        argv
      ),
      timeoutMillis: argv[timeoutOption.name] || undefined
    });
    if (compiledGraphHasErrors(compiledGraph)) {
      printCompiledGraphErrors(compiledGraph.graphErrors);
      return 1;
    }
    if (!argv[jsonOutputOption.name]) {
      printSuccess("Compiled successfully.\n");
    }
    const warehouse = compiledGraph.projectConfig.warehouse || "bigquery";
    const readCredentials = credentials.read(
      credentialsPathWithEnvironment(argv[projectDirMustExistOption.name], argv),
      warehouse
    );

    if (!compiledGraph.tests.length) {
      printError("No unit tests found.");
      return 1;
    }

    if (!argv[jsonOutputOption.name]) {
      print(`Running ${compiledGraph.tests.length} unit tests...\n`);
    }
    let dbadapter: IDbAdapter;
    if (warehouse.toLowerCase() === "supabase") {
      dbadapter = await SupabaseDbAdapter.create(readCredentials);
    } else if (warehouse.toLowerCase() === "postgres") {
      dbadapter = await PostgresDbAdapter.create(readCredentials);
    } else if (warehouse.toLowerCase() === "mysql") {
      dbadapter = await MySqlDbAdapter.create(readCredentials);
    } else {
      dbadapter = new BigQueryDbAdapter(readCredentials);
    }
    const testResults = await test(dbadapter, compiledGraph.tests);
    if (!argv[jsonOutputOption.name]) {
      testResults.forEach(testResult => printTestResult(testResult));
    } else {
      // Print all results as JSON if the option is set.
      print(prettyJsonStringify(testResults));
    }
    return testResults.every(testResult => testResult.successful) ? 0 : 1;
  }
};
