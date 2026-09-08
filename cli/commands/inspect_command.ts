import { queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { prettyJsonStringify } from "sa/cli/api/utils";
import {
  NO_ARTIFACTS,
  printArtifactRows,
  resolveArtifactViews
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
    views
  );
  let latestRun: any = null;
  let failures: any[] = [];
  if (hasRuns) {
    const latest = await queryParquet(
      "select run_id, run_status, " +
        "count(*) filter (where status = 'SUCCESSFUL') as succeeded, " +
        "count(*) filter (where status = 'FAILED') as failed, " +
        "max(end_millis) - min(start_millis) as wall_ms " +
        "from runs where run_id = (select max(run_id) from runs) group by run_id, run_status",
      views
    );
    latestRun = latest[0] || null;
    failures = await queryParquet(
      "select readable_name, error_message from runs " +
        "where run_id = (select max(run_id) from runs) and status = 'FAILED' limit 20",
      views
    );
  }

  if (json) {
    print(prettyJsonStringify({ actionsByType, latestRun, failures }));
    return 0;
  }
  print("Actions by type:");
  printArtifactRows(actionsByType);
  if (!hasRuns || !latestRun) {
    print("\nNo runs recorded yet.");
  } else {
    print(
      `\nLatest run (${latestRun.run_status}): ${latestRun.succeeded} succeeded, ` +
        `${latestRun.failed} failed, ${latestRun.wall_ms}ms`
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
    "Summarize the project's artifacts: action counts by type, the latest run's status/" +
    "timing, and recent failures.",
  positionalOptions: [projectDirOption],
  options: [jsonOutputOption],
  processFn: async (argv: any) =>
    runInspect(argv[projectDirOption.name], argv[jsonOutputOption.name])
};
