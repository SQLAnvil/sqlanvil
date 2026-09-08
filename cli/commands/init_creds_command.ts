import * as fs from "fs";
import * as path from "path";

import { credentials } from "sa/cli/api";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { prettyJsonStringify } from "sa/cli/api/utils";
import { projectDirMustExistOption } from "sa/cli/common_options";
import { print, printInitCredsResult, printSuccess } from "sa/cli/console";
import { getBigQueryCredentials } from "sa/cli/credentials";
import { ICommand, option } from "sa/cli/yargswrapper";

interface InitCredsArgv {
  "project-dir": string;
  "test-connection": boolean;
}

const testConnectionOptionName = "test-connection";

export const initCredsCommand: ICommand = {
  format: `init-creds [${projectDirMustExistOption.name}]`,
  description:
    `Create a ${credentials.CREDENTIALS_FILENAME} file for sqlanvil to use when ` +
    `accessing BigQuery.`,
  positionalOptions: [projectDirMustExistOption],
  options: [
    option(testConnectionOptionName, {
      describe: "If true, a test query will be run using your final credentials.",
      type: "boolean",
      default: true
    })
  ],
  processFn: async (argv: InitCredsArgv) => {
    const finalCredentials = getBigQueryCredentials();
    if (argv[testConnectionOptionName]) {
      print("\nRunning connection test...");
      const dbadapter = new BigQueryDbAdapter(finalCredentials);
      const testResult = await credentials.test(dbadapter);
      switch (testResult.status) {
        case credentials.TestResultStatus.SUCCESSFUL: {
          printSuccess("\nCredentials test query completed successfully.\n");
          break;
        }
        case credentials.TestResultStatus.TIMED_OUT: {
          throw new Error("Credentials test connection timed out.");
        }
        case credentials.TestResultStatus.OTHER_ERROR: {
          throw new Error(
            `Credentials test query failed: ${testResult.error.stack || testResult.error.message}`
          );
        }
      }
    } else {
      print("\nCredentials test query was not run.\n");
    }
    const filePath = path.resolve(
      argv[projectDirMustExistOption.name],
      credentials.CREDENTIALS_FILENAME
    );
    fs.writeFileSync(filePath, prettyJsonStringify(finalCredentials));
    printInitCredsResult(filePath);
    return 0;
  }
};
