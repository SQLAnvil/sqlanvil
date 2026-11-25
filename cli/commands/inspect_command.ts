import { findLatestRun, LatestRun } from "sa/cli/api/commands/artifacts";
import { queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  NO_ARTIFACTS,
  printArtifactRows,
  resolveArtifactViews,
} from "sa/cli/commands/artifact_views";
import { jsonOutputOption, projectDirOption } from "sa/cli/common_options";
import { print, printError } from "sa/cli/console";
import { ICommand } from "sa/cli/yargswrapper";

async function runInspect(projectDir: string, json: boolean): Promise<number> {
  const { views, hasCatalog, hasRuns } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const actionsByType = await queryParquet(
    "select type, count(*) as n from actions group by type order by type",
    views,
  );
  const latestRun: LatestRun | null = (await findLatestRun(views)) || null;
  let failures: any[] = [];
  if (latestRun && hasRuns) {
    failures = await queryParquet(
      "select readable_name, error_message from runs " +
        `where run_id = ${latestRun.run_id} and status = 'FAILED' ` +
        "order by readable_name limit 20",
      views,
    );
  }

  if (json) {
    print(prettyJsonStringify({ actionsByType, latestRun, failures }));
    return 0;
  }
  print("Actions by type:");
  printArtifactRows(actionsByType);
  if (!latestRun) {
    print("\nNo runs recorded yet.");
  } else {
    print(
      `\nLatest run (${latestRun.run_status}): ${latestRun.succeeded} succeeded, ` +
        `${latestRun.failed} failed, ${latestRun.wall_ms}ms`,
    );
    if (failures.length > 0) {
      print("\nFailures:");
      printArtifactRows(failures);
    }
  }
  return 0;
}

export const inspectCommand: ICommand = {
  format: `inspect [${projectDirOption.name}]`,
  description:
    "Summarize the artifacts: action counts by type, and the latest run's status, timing " +
    "and failures.",
  positionalOptions: [projectDirOption],
  options: [jsonOutputOption],
  processFn: async (argv: any) =>
    runInspect(argv[projectDirOption.name], argv[jsonOutputOption.name]),
};
