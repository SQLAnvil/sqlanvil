<!-- Format: references/prd-format.md, "errors.md".
Entry lines in order: Detected, Classification, Confirmed, Touches, Evidence (at most 20 lines, continuation lines indented two spaces), Diagnosis, Resolution, Recurrence of. -->

# Error ledger

### E-001 inspect wall time counts skipped and disabled actions from epoch zero
Detected: 2026-11-22, adoption extract of artifacts (cli/commands/inspect_command.ts:29 @f4b3f49e)
Classification: code bug
Touches: FR-018, FR-019
Diagnosis: inspect computes wall_ms as `max(end_millis) - min(start_millis)` over every row of the latest run. runRows writes 0 for start_millis and end_millis when an action result has no timing (artifact_rows.ts:78-81, 171-172). The runner records SKIPPED and DISABLED action results with no timing (cli/api/commands/run.ts:350-354, 396-401, 428-431). So one such action makes min(start_millis) 0, and inspect prints the latest end time in epoch milliseconds (about 1.7e12 ms) as the run's wall time. Two things say it should not. The sibling code treats 0 as missing: duration_millis is set only when both times are non-zero (artifact_rows.ts:182). And the command describes this figure as "the latest run's status, timing" (inspect_command.ts:65; cli/README.md:402 "wall time").
Resolution: open, intended: the wall time is the latest end_millis minus the earliest start_millis over the latest run's rows that have non-zero start and end times, and 0 when no row has both (confirmed a bug by Ivan Histand, 2026-11-22)
Recurrence of: -

### E-002 A run with no action results does not show in inspect or docs
Detected: 2026-11-22, adoption extract of artifacts (cli/api/commands/artifact_rows.ts:168 @f4b3f49e)
Classification: code bug
Touches: FR-005, FR-018, FR-019, FR-021
Diagnosis: The run id and run status are stored only in per-action rows (artifacts.ts:29-39, artifact_rows.ts:170-185). A run result with no action results therefore writes `run_<id>.parquet` with zero rows (artifacts.ts:64-70, duckdb_artifacts.ts:30-32), and `max(run_id)` never sees that run (inspect_command.ts:30, 36; docs.ts:63). inspect and docs then report the previous run as "Latest run" or "Last run", or "No runs recorded yet." when it is the only run. The docs say otherwise: inspect summarizes "the latest run's status" (inspect_command.ts:65, cli/README.md:402), run "adds a run-history entry" (cli/README.md:53), and docs shows "last-run status" (docs.ts:5).
Resolution: open, intended: a run with no action results is recorded with its run id and run status, and inspect and docs report it as the latest run with 0 succeeded and 0 failed (confirmed a bug by Ivan Histand, 2026-11-22)
Recurrence of: -

### E-003 An empty artifact file does not keep its columns' types
Detected: 2026-11-22, adoption extract of artifacts (cli/api/dbadapters/duckdb_artifacts.ts:31 @f4b3f49e)
Classification: code bug
Touches: FR-006
Diagnosis: The comments say an empty rowset produces a "correctly-typed 0-row Parquet" (artifacts.ts:14; duckdb_artifacts.ts:16-18). The writer only has column names, though. It writes one all-null JSON row and filters it out with `WHERE false`, so DuckDB's read_json_auto infers each column from nulls alone. Those columns cannot get the BOOLEAN, BIGINT and VARCHAR types the same columns get from real rows (disabled, run_id, start_millis and the rest). Two things need a run to confirm: the exact type DuckDB infers, and whether a `runs` glob that mixes such a file with typed files fails to read.
Resolution: open, intended: an empty artifact file has the same column names and the same column types as a file written from rows, so a runs glob that mixes it with typed files reads cleanly (confirmed a bug by Ivan Histand, 2026-11-22)
Recurrence of: -

### E-004 docs indexes models by their readable name
Detected: 2026-11-22, adoption extract of artifacts (cli/api/commands/docs.ts:76 @f4b3f49e)
Classification: code bug
Touches: FR-021
Diagnosis: buildDocsModel keys each model's last-run status (docs.ts:75-77, 103) and its depends-on list (docs.ts:81-87, 104) by readable_name, even though every row carries target_key. core/targets.ts:12-13 says of targetAsReadableString: "This is an ambiguous transformation, multiple targets may map to the same string and it should not be used for indexing. Use targetStringifier instead." Two targets with the same readable name share one status and one merged dependency list. For example, database a, schema b, name c and schema a.b, name c both read as a.b.c.
Resolution: open, intended: docs matches a model's status and depends-on list by target_key, so two targets that share a readable name keep their own status and dependencies (confirmed a bug by Ivan Histand, 2026-11-22)
Recurrence of: -

### E-005 The action-row type list omits import and script
Detected: 2026-11-22, adoption extract of artifacts (cli/api/commands/artifact_rows.ts:15 @f4b3f49e)
Classification: code bug
Touches: FR-002
Diagnosis: The ActionRow `type` field is documented as `table | view | incremental | operation | assertion | export | declaration` (artifact_rows.ts:15). catalogRows also writes rows of type `import` (artifact_rows.ts:154-156, added in f8a58c03) and `script` (artifact_rows.ts:157-159, added in 306c90f4). The messages of those two commits back the code ("Wired through … build/prune/run/artifacts"; scripts "covered by run history"). The comment and the code disagree, and the owner decides which is right. FR-002 leaves both types out until then.
Resolution: not a defect: the code is right and the ActionRow type comment at artifact_rows.ts:15 is stale; the catalog writes import and script rows (confirmed by Ivan Histand, 2026-11-22)
Recurrence of: -

### E-006 A path that contains a single quote breaks the artifacts
Detected: 2026-11-22, confirmation of FR-001 (open question Q-07)
Classification: code bug
Touches: FR-001, FR-010
Diagnosis: Project and temporary paths go into DuckDB SQL inside single quotes without escaping (cli/api/dbadapters/duckdb_artifacts.ts:38, 70; cli/api/dbadapters/duckdb.ts:59 @f4b3f49e). A path holding a `'` ends the string literal early, so the write fails and is skipped with a warning (FR-008), and query, inspect and docs fail on that project. The owner confirmed it a bug on 2026-11-22.
Resolution: open, intended: a path that contains a single quote works like any other path, for writing and for reading the artifacts (Ivan Histand, 2026-11-22)
Recurrence of: -

### E-007 inspect lists an arbitrary 20 of more than 20 failures
Detected: 2026-11-22, confirmation of FR-018 (open question Q-10)
Classification: code bug
Touches: FR-018, FR-019
Diagnosis: inspect selects the latest run's FAILED rows with `limit 20` and no ORDER BY (cli/commands/inspect_command.ts:34-38 @f4b3f49e), so when there are more than 20 failures, which 20 it prints, and in what order, is up to DuckDB. The owner confirmed it a bug on 2026-11-22.
Resolution: open, intended: inspect lists the first 20 failures in readable_name order, in the table and in the JSON (Ivan Histand, 2026-11-22)
Recurrence of: -
