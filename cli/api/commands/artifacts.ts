import * as path from "path";

import { catalogRows, runRows } from "sa/cli/api/commands/artifact_rows";
import { writeParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";
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
  "description"
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
  "error_message"
];

export interface WriteArtifactsOptions {
  runResult?: sqlanvil.IRunResult;
  runId?: number;
}

/** Write catalog Parquet (always) and a run-history Parquet (when a runResult is given). */
export async function writeArtifacts(
  compiledGraph: sqlanvil.ICompiledGraph,
  projectDir: string,
  options: WriteArtifactsOptions = {}
): Promise<{ targetDir: string }> {
  const targetDir = path.join(projectDir, TARGET_DIR);
  const catalogDir = path.join(targetDir, "catalog");

  const { actions, dependencies, columns } = catalogRows(compiledGraph);
  await writeParquet(actions, path.join(catalogDir, "actions.parquet"), ACTION_COLUMNS);
  await writeParquet(
    dependencies,
    path.join(catalogDir, "dependencies.parquet"),
    DEPENDENCY_COLUMNS
  );
  await writeParquet(columns, path.join(catalogDir, "columns.parquet"), COLUMN_COLUMNS);

  if (options.runResult) {
    const runId = options.runId !== undefined ? options.runId : Date.now();
    await writeParquet(
      runRows(options.runResult, runId),
      path.join(targetDir, "runs", `run_${runId}.parquet`),
      RUN_COLUMNS
    );
  }

  return { targetDir };
}

/**
 * Best-effort wrapper: artifacts are a convenience, so a DuckDB load / IO failure must never fail
 * the surrounding `compile`/`run`. On error, calls `warn` (if given) and resolves.
 */
export async function safeWriteArtifacts(
  compiledGraph: sqlanvil.ICompiledGraph,
  projectDir: string,
  options: WriteArtifactsOptions & { warn?: (message: string) => void } = {}
): Promise<void> {
  try {
    await writeArtifacts(compiledGraph, projectDir, options);
  } catch (e) {
    if (options.warn) {
      options.warn(`Artifacts skipped: ${e.message}`);
    }
  }
}
