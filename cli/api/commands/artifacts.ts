import * as path from "path";

import { catalogRows, runRows, runSummaryRow } from "sa/cli/api/commands/artifact_rows";
import { ArtifactView, queryParquet, writeParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { sqlanvil } from "sa/protos/ts";

/**
 * Writes a project's compiled-graph catalog (and, after a run, its run history) to Parquet under
 * `<projectDir>/target/`, queryable via `sqlanvil query` / `sqlanvil inspect`.
 */

export const TARGET_DIR = "target";

// Ordered column lists — used to emit correctly-typed 0-row Parquet for empty rowsets.
const ACTION_COLUMNS = [
  "target_key",
  "database",
  "schema",
  "name",
  "readable_name",
  "type",
  "tags",
  "disabled",
  "file_name",
  "description",
];
const DEPENDENCY_COLUMNS = ["from_target_key", "to_target_key", "from_readable", "to_readable"];
const COLUMN_COLUMNS = ["target_key", "readable_name", "column_name", "description"];
const RUN_COLUMNS = [
  "run_id",
  "run_status",
  "target_key",
  "readable_name",
  "status",
  "start_millis",
  "end_millis",
  "duration_millis",
  "error_message",
];
const RUN_TYPES = {
  run_id: "BIGINT",
  run_status: "VARCHAR",
  target_key: "VARCHAR",
  readable_name: "VARCHAR",
  status: "VARCHAR",
  start_millis: "BIGINT",
  end_millis: "BIGINT",
  duration_millis: "BIGINT",
  error_message: "VARCHAR",
};
const RUN_SUMMARY_COLUMNS = ["run_id", "run_status"];
const RUN_SUMMARY_TYPES = { run_id: "BIGINT", run_status: "VARCHAR" };

export interface WriteArtifactsOptions {
  runResult?: sqlanvil.IRunResult;
  runId?: number;
}

/** Write catalog Parquet (always) and a run-history Parquet (when a runResult is given). */
export async function writeArtifacts(
  compiledGraph: sqlanvil.ICompiledGraph,
  projectDir: string,
  options: WriteArtifactsOptions = {},
): Promise<{ targetDir: string }> {
  const targetDir = path.join(projectDir, TARGET_DIR);
  const catalogDir = path.join(targetDir, "catalog");

  const { actions, dependencies, columns } = catalogRows(compiledGraph);
  await writeParquet(actions, path.join(catalogDir, "actions.parquet"), ACTION_COLUMNS);
  await writeParquet(
    dependencies,
    path.join(catalogDir, "dependencies.parquet"),
    DEPENDENCY_COLUMNS,
  );
  await writeParquet(columns, path.join(catalogDir, "columns.parquet"), COLUMN_COLUMNS);

  if (options.runResult) {
    const runId = options.runId !== undefined ? options.runId : Date.now();
    await writeParquet(
      runRows(options.runResult, runId),
      path.join(targetDir, "runs", `run_${runId}.parquet`),
      RUN_COLUMNS,
      RUN_TYPES,
    );
    await writeParquet(
      [runSummaryRow(options.runResult, runId)],
      path.join(targetDir, "run_summary", `run_${runId}.parquet`),
      RUN_SUMMARY_COLUMNS,
      RUN_SUMMARY_TYPES,
    );
  }

  return { targetDir };
}

export interface LatestRun {
  run_id: number;
  run_status: string;
  succeeded: number;
  failed: number;
  wall_ms: number;
}

/**
 * The latest recorded run: the highest run_id in the `run_summary` view, or, when there is no
 * `run_summary` view, in the `runs` view; with its counts and wall time from its `runs` rows.
 * Undefined when neither view is given.
 */
export async function findLatestRun(views: ArtifactView[]): Promise<LatestRun | undefined> {
  const has = (name: string) => views.some((v) => v.name === name);
  const headView = has("run_summary") ? "run_summary" : has("runs") ? "runs" : undefined;
  if (!headView) {
    return undefined;
  }
  const head = await queryParquet(
    `select run_id, run_status from ${headView} order by run_id desc limit 1`,
    views,
  );
  if (!head[0]) {
    return undefined;
  }
  const runId = Number(head[0].run_id);
  let counts = { succeeded: 0, failed: 0, wall_ms: 0 };
  if (has("runs")) {
    const rows = await queryParquet(
      "select count(*) filter (where status = 'SUCCESSFUL') as succeeded, " +
        "count(*) filter (where status = 'FAILED') as failed, " +
        "coalesce(max(end_millis) filter (where start_millis <> 0 and end_millis <> 0) - " +
        "min(start_millis) filter (where start_millis <> 0 and end_millis <> 0), 0) as wall_ms " +
        `from runs where run_id = ${runId}`,
      views,
    );
    counts = {
      succeeded: Number(rows[0].succeeded),
      failed: Number(rows[0].failed),
      wall_ms: Number(rows[0].wall_ms),
    };
  }
  return { run_id: runId, run_status: head[0].run_status, ...counts };
}

/**
 * Best-effort wrapper: artifacts are a convenience, so a DuckDB load / IO failure must never fail
 * the surrounding `compile`/`run`. On error, calls `warn` (if given) and resolves.
 */
export async function safeWriteArtifacts(
  compiledGraph: sqlanvil.ICompiledGraph,
  projectDir: string,
  options: WriteArtifactsOptions & { warn?: (message: string) => void } = {},
): Promise<void> {
  try {
    await writeArtifacts(compiledGraph, projectDir, options);
  } catch (e) {
    if (options.warn) {
      options.warn(`Artifacts skipped: ${e.message}`);
    }
  }
}
