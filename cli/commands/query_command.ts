import { queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  NO_ARTIFACTS,
  printArtifactRows,
  resolveArtifactViews
} from "sa/cli/commands/artifact_views";
import { jsonOutputOption, projectDirOption } from "sa/cli/common_options";
import { print, printError } from "sa/cli/console";
import { ICommand, positionalOption } from "sa/cli/yargswrapper";

async function runQuery(projectDir: string, sql: string, json: boolean): Promise<number> {
  const { views, hasCatalog } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const rows = await queryParquet(sql, views);
  if (json) {
    print(prettyJsonStringify(rows));
  } else {
    printArtifactRows(rows);
  }
  return 0;
}

export const queryCommand: ICommand = {
  format: `query [sql] [${projectDirOption.name}]`,
  description:
    "Run SQL over the project's queryable artifacts in target/ (views: actions, " +
    "dependencies, columns, runs), via the bundled DuckDB.",
  positionalOptions: [
    positionalOption(
      "sql",
      { describe: 'SQL to run, e.g. "select type, count(*) from actions group by 1".' },
      (argv: { sql?: string }) => {
        if (!argv.sql) {
          throw new Error('Provide a SQL query, e.g. sqlanvil query "select * from actions".');
        }
      }
    ),
    projectDirOption
  ],
  options: [jsonOutputOption],
  processFn: async (argv: any) =>
    runQuery(argv[projectDirOption.name], argv.sql, argv[jsonOutputOption.name])
};
