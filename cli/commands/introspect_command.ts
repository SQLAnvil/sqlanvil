import * as fs from "fs";

import { introspectToSqlx } from "sa/cli/api";
import { projectDirOption } from "sa/cli/common_options";
import { print, printSuccess } from "sa/cli/console";
import { ICommand, option, positionalOption } from "sa/cli/yargswrapper";

interface IntrospectArgv {
  connection: string;
  tableRef: string;
  "project-dir": string;
  output?: string;
}

export const introspectCommand: ICommand = {
  format: `introspect <connection> <tableRef> [${projectDirOption.name}]`,
  description:
    "Read a source table's schema from a connection and write a declaration .sqlx with columnTypes.",
  positionalOptions: [
    positionalOption("connection", {
      describe: "Connection name (from workflow_settings.yaml connections)."
    }),
    positionalOption("tableRef", {
      describe: "Source table as schema.table (or just table)."
    }),
    projectDirOption
  ],
  options: [
    option("output", {
      describe: "File to write the declaration .sqlx to. Prints to stdout if omitted.",
      type: "string"
    })
  ],
  processFn: async (argv: IntrospectArgv) => {
    const projectDir = argv[projectDirOption.name];
    const sqlx = await introspectToSqlx(projectDir, argv.connection, argv.tableRef);
    if (argv.output) {
      fs.writeFileSync(argv.output, sqlx);
      printSuccess(`Wrote declaration to ${argv.output}`);
    } else {
      print(sqlx);
    }
    return 0;
  }
};
