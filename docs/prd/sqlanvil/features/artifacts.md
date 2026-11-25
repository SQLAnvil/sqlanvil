<!-- Format: references/prd-format.md, "Requirement blocks". -->

# Artifacts

### UJ-01 Explore a project's catalog and last run
Status: live (since 1.0.0)
Flow: 1. A data engineer runs `sqlanvil compile` or `sqlanvil run` on a project, which writes the artifacts under `target/` → 2. runs `sqlanvil inspect` and sees the actions by type and the latest run's status, timing and failures → 3. runs `sqlanvil query "<sql>"` over the actions, dependencies, columns, runs and run_summary views and sees the rows → 4. runs `sqlanvil docs` and opens `target/docs/index.html` to browse the models, their columns, dependencies and last-run status
Traces: FR-001, FR-005, FR-011, FR-018, FR-020

### FR-001 Write the catalog Parquet files
Status: verified
Source: cli/api/commands/artifacts.ts:89 @d6eab0db
  cli/api/dbadapters/duckdb_artifacts.ts:28 @d6eab0db
  cli/api/dbadapters/duckdb_artifacts.ts:44 @81a1434f
Flow: 1. writeArtifacts(graph, projectDir) → 2. shapes catalog rows → 3. writes actions, dependencies and columns Parquet under `<projectDir>/target/catalog/` → 4. resolves `{targetDir}`
Acceptance (EARS):
- AC-001.1 When writeArtifacts is called with a compiled graph and a project directory, the artifact writer shall write `target/catalog/actions.parquet`, `target/catalog/dependencies.parquet` and `target/catalog/columns.parquet` under that directory, creating the directories that are missing, and resolve with `targetDir` set to `<projectDir>/target`.
- AC-001.2 The artifact writer shall write `target/catalog/actions.parquet` with the columns target_key, database, schema, name, readable_name, type, tags, disabled, file_name, description; `target/catalog/dependencies.parquet` with from_target_key, to_target_key, from_readable, to_readable; and `target/catalog/columns.parquet` with target_key, readable_name, column_name, description, in those orders. Every column has type VARCHAR except actions.disabled, which is BOOLEAN, and no value is null.
- AC-001.3 When writeArtifacts is called again for the same project directory, the artifact writer shall replace the three catalog files with the rows of the new graph.
- AC-001.4 When the project directory's path contains a single quote, the artifact writer shall write the artifacts as it does for any other path.
Errors: -
Edge cases: no runResult → no run file (AC-005.7); empty graph → AC-006.1; a path with a single quote → AC-001.4 (E-006)
Tests: T-001.1 [integration], T-001.2 [integration], T-001.3 [integration], T-001.4 [integration]  (test-cases/artifacts.yaml)
Traces: UJ-01; `target/catalog/actions.parquet`, `target/catalog/dependencies.parquet`, `target/catalog/columns.parquet`

### FR-002 Shape one catalog row per action
Status: live (since 1.0.0)
Source: cli/api/commands/artifact_rows.ts:91 @f4b3f49e
  cli/api/commands/artifact_rows.ts:131 @f4b3f49e
  cli/api/commands/artifact_rows.ts:67 @f4b3f49e
  cli/api/commands/artifact_rows.ts:154 @f4b3f49e
Acceptance (EARS):
- AC-002.1 When the catalog is written, the artifact writer shall write one actions row for each table, operation, assertion, export, import, script and declaration of the compiled graph.
- AC-002.2 The artifact writer shall set an action row's type to `view` for a table of type VIEW, `incremental` for a table of type INCREMENTAL, `table` for a table of any other or no type, and `operation`, `assertion`, `export`, `import`, `script` or `declaration` for an action of that kind.
- AC-002.3 The artifact writer shall set target_key to the action's target as JSON with its keys sorted, readable_name to `<database>.<schema>.<name>` when the target has a database and `<schema>.<name>` otherwise, and database, schema and name to the target's parts.
- AC-002.4 The artifact writer shall set tags to the JSON array text of the action's tags, disabled to whether the action is disabled, file_name to the action's file name and description to its action descriptor's description.
- AC-002.5 If an action has no tags, file name, descriptor description, target database or disabled flag, the artifact writer shall write `[]`, an empty string or false in that column.
Errors: -
Edge cases: a target with dots in its parts gives an ambiguous readable_name (E-004)
Tests: T-002.1 [integration], T-002.2 [integration], T-002.3 [integration], T-002.4 [integration], T-002.5 [integration]  (test-cases/artifacts.yaml)
Traces: `target/catalog/actions.parquet`

### FR-003 Shape one dependency row per dependency edge
Status: live (since 1.0.0)
Source: cli/api/commands/artifact_rows.ts:107 @f4b3f49e
Acceptance (EARS):
- AC-003.1 When the catalog is written, the artifact writer shall write one dependencies row for each entry of each action's dependency targets, with from_target_key and from_readable naming the action and to_target_key and to_readable naming the dependency, in the formats of AC-002.3.
- AC-003.2 If an action has no dependency targets, the artifact writer shall write no dependencies row from it.
Errors: -
Tests: T-003.1 [integration], T-003.2 [integration]  (test-cases/artifacts.yaml)
Traces: `target/catalog/dependencies.parquet`

### FR-004 Shape one column row per documented column
Status: live (since 1.0.0)
Source: cli/api/commands/artifact_rows.ts:118 @f4b3f49e
Acceptance (EARS):
- AC-004.1 When the catalog is written, the artifact writer shall write one columns row for each column of each action's descriptor, with column_name set to the column's path parts joined with `.` and description set to the column's description, or an empty string when it has none.
- AC-004.2 If an action has no descriptor columns, the artifact writer shall write no columns row for it.
Errors: -
Tests: T-004.1 [integration], T-004.2 [integration]  (test-cases/artifacts.yaml)
Traces: `target/catalog/columns.parquet`

### FR-005 Write a run-history Parquet file per run
Status: verified
Source: cli/api/commands/artifacts.ts:84 @d6310e44
  cli/api/commands/artifact_rows.ts:181 @d6310e44
  cli/api/commands/artifact_rows.ts:64 @d6310e44
  cli/api/commands/artifact_rows.ts:83 @d6310e44
Acceptance (EARS):
- AC-005.1 When writeArtifacts is called with a run result and a run id, the artifact writer shall write `target/runs/run_<run id>.parquet` with one row per action result, in the columns run_id, run_status, target_key, readable_name, status, start_millis, end_millis, duration_millis, error_message; run_id, start_millis, end_millis and duration_millis have type BIGINT, the other columns VARCHAR, and no value is null.
- AC-005.2 When writeArtifacts is called with a run result and no run id, the artifact writer shall use the current time in epoch milliseconds as the run id.
- AC-005.3 The artifact writer shall set run_status to the name of the run result's execution status and status to the name of the action result's execution status.
- AC-005.4 If the run result or an action result has no status, the artifact writer shall write `UNKNOWN` for that status.
- AC-005.5 The artifact writer shall set start_millis and end_millis from the action result's timing, 0 when absent, and duration_millis to end_millis minus start_millis when both are non-zero and 0 otherwise.
- AC-005.6 The artifact writer shall set error_message to the error message of the first task of the action result that has one, and an empty string when no task has one.
- AC-005.7 When writeArtifacts is called without a run result, the artifact writer shall write no file under `target/runs/` or `target/run_summary/`.
- AC-005.8 When a run-history or run-summary file is written, the artifact writer shall leave the other files under `target/runs/` and `target/run_summary/` unchanged.
- AC-005.9 When writeArtifacts is called with a run result that has no action results, the artifact writer shall write that run's `target/runs/run_<run id>.parquet` with zero rows and still record the run in its run-summary file (AC-005.11), so that inspect and docs list the run.
- AC-005.10 The artifact writer shall keep every run-history file under `target/runs/` and every run-summary file under `target/run_summary/` until the user deletes it.
- AC-005.11 When writeArtifacts is called with a run result, the artifact writer shall write `target/run_summary/run_<run id>.parquet` with exactly one row, in the columns run_id (BIGINT) and run_status (VARCHAR, set as AC-005.3 and AC-005.4 say), whether or not the run result has action results, and no value is null.
Errors: -
Edge cases: a run result with no action results → AC-005.9, AC-005.11 (E-002)
Tests: T-005.1 [integration], T-005.2 [integration], T-005.3 [integration], T-005.4 [integration], T-005.5 [integration], T-005.6 [integration], T-005.7 [integration], T-005.8 [integration], T-005.9 [integration], T-005.10 [integration], T-005.11 [integration], T-005.12 [integration]  (test-cases/artifacts.yaml)
Traces: UJ-01; `target/runs/run_<run id>.parquet`; `target/run_summary/run_<run id>.parquet`

### FR-006 Keep the columns of an empty artifact file
Status: verified
Source: cli/api/dbadapters/duckdb_artifacts.ts:33 @0ac7a311
Acceptance (EARS):
- AC-006.1 When a rowset is empty, the artifact writer shall write a Parquet file with zero rows whose column names are that file's column list, in order, and whose column types are the types the same columns have in a file written from rows.
Errors: -
Edge cases: the column types of such a file → AC-006.1 (E-003)
Tests: T-006.1 [integration]  (test-cases/artifacts.yaml)
Traces: `target/catalog/actions.parquet`

### FR-007 Remove the staging file after a Parquet write
Status: live (since 1.0.0)
Source: cli/api/dbadapters/duckdb_artifacts.ts:26 @f4b3f49e
  cli/api/dbadapters/duckdb_artifacts.ts:41 @f4b3f49e
Acceptance (EARS):
- AC-007.1 When a Parquet write succeeds, the artifact writer shall leave no `sa_artifact_<pid>_*.json` staging file in the system temporary directory.
- AC-007.2 If the DuckDB COPY of a Parquet write fails, the artifact writer shall remove its staging file and reject with the error.
Errors: -
Tests: T-007.1 [integration], T-007.2 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-008 Never fail the caller when artifacts cannot be written
Status: live (since 1.0.0)
Source: cli/api/commands/artifacts.ts:80 @f4b3f49e
Acceptance (EARS):
- AC-008.1 If writing the artifacts fails, safeWriteArtifacts shall call its warn callback once with `Artifacts skipped: ` followed by the error's message, and resolve.
- AC-008.2 If writing the artifacts fails and no warn callback is given, safeWriteArtifacts shall resolve and write no output.
Errors: ARTIFACTS_SKIPPED (contracts/errors.yaml)
Tests: T-008.1 [integration], T-008.2 [integration]  (test-cases/artifacts.yaml)
Traces: called by compile and run (OUTSIDE THE BOUNDARY)

### FR-009 Read the project's artifacts, and refuse without a catalog
Status: live (since 1.0.0)
Source: cli/commands/artifact_views.ts:33 @f4b3f49e
  cli/commands/query_command.ts:14 @f4b3f49e
  cli/commands/inspect_command.ts:14 @f4b3f49e
  cli/commands/docs_command.ts:13 @f4b3f49e
Acceptance (EARS):
- AC-009.1 If `<project-dir>/target/catalog/actions.parquet` does not exist, the query command shall print ``No artifacts found under target/. Run `sqlanvil compile` (or `run`) first.`` on stderr and exit with code 1.
- AC-009.2 If `<project-dir>/target/catalog/actions.parquet` does not exist, the inspect command shall print the same message on stderr and exit with code 1.
- AC-009.3 If `<project-dir>/target/catalog/actions.parquet` does not exist, the docs command shall print the same message on stderr, write no `target/docs/index.html`, and exit with code 1.
- AC-009.4 When no project-dir argument is given, the query, inspect and docs commands shall read the artifacts under the current directory.
Errors: ARTIFACTS_NOT_FOUND (contracts/errors.yaml)
Edge cases: a project-dir that does not exist → AC-009.1 to AC-009.3
Tests: T-009.1 [integration], T-009.2 [integration], T-009.3 [integration], T-009.4 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-010 Expose the artifacts as DuckDB views
Status: verified
Source: cli/commands/artifact_views.ts:33 @d6310e44
  cli/commands/artifact_views.ts:28 @f4b3f49e
  cli/api/dbadapters/duckdb_artifacts.ts:74 @d6eab0db
Acceptance (EARS):
- AC-010.1 When an artifact command runs, the command shall expose `target/catalog/actions.parquet`, `target/catalog/dependencies.parquet` and `target/catalog/columns.parquet` as the views `actions`, `dependencies` and `columns`.
- AC-010.2 While `target/runs/` holds at least one `.parquet` file, the artifact commands shall expose every `target/runs/*.parquet` file together as one view named `runs`.
- AC-010.3 If `target/runs/` is missing or holds no `.parquet` file, the artifact commands shall create no `runs` view.
- AC-010.4 If `target/catalog/dependencies.parquet` or `target/catalog/columns.parquet` is missing while `target/catalog/actions.parquet` exists, the query command shall still run SQL that reads only the views that exist.
- AC-010.5 When the project directory's path contains a single quote, the artifact commands shall read the artifacts as they do for any other path.
- AC-010.6 While `target/run_summary/` holds at least one `.parquet` file, the artifact commands shall expose every `target/run_summary/*.parquet` file together as one view named `run_summary`; if `target/run_summary/` is missing or holds no `.parquet` file, they shall create no `run_summary` view.
Errors: -
Edge cases: a path with a single quote → AC-010.5 (E-006); artifacts written before run-summary files existed → AC-010.6 (no `run_summary` view)
Tests: T-010.1 [integration], T-010.2 [integration], T-010.3 [integration], T-010.4 [integration], T-010.5 [integration], T-010.6 [integration], T-010.7 [integration]  (test-cases/artifacts.yaml)
Traces: views `actions`, `dependencies`, `columns`, `runs`, `run_summary`

### FR-011 Run SQL over the artifacts with the query command
Status: live (since 1.0.0)
Source: cli/commands/query_command.ts:18 @f4b3f49e
  cli/commands/artifact_views.ts:36 @f4b3f49e
Acceptance (EARS):
- AC-011.1 When `sqlanvil query "<sql>" <project-dir>` runs on a project with a catalog, the query command shall run the SQL over the artifact views with the bundled DuckDB and print on stdout a header line of the column names, a line of dashes per column, and one line per row, each value padded with spaces to its column's width (the longest of the column name and its values) and the columns separated by two spaces, then an empty line and `(<n> rows)`, or `(1 row)` for one row, and exit with code 0.
- AC-011.2 When the SQL returns no rows, the query command shall print `(0 rows)` alone and exit with code 0.
- AC-011.3 The query command shall print a null value as an empty string in the table.
- AC-011.4 If DuckDB rejects the SQL, the query command shall print an error containing DuckDB's error message on stderr and exit with code 1.
Errors: QUERY_SQL_REJECTED (contracts/errors.yaml)
Edge cases: SQL that DuckDB rejects → AC-011.4 (owner, 2026-11-22); one positional argument → AC-013.3
Tests: T-011.1 [integration], T-011.2 [integration], T-011.3 [integration], T-011.4 [integration]  (test-cases/artifacts.yaml)
Traces: UJ-01

### FR-012 Print query results as JSON
Status: live (since 1.0.0)
Source: cli/commands/query_command.ts:19 @f4b3f49e
Acceptance (EARS):
- AC-012.1 When `sqlanvil query "<sql>" <project-dir> --json` runs on a project with a catalog, the query command shall print the rows on stdout as one JSON array of objects keyed by column name, indented four spaces, and exit with code 0.
Errors: -
Tests: T-012.1 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-013 Require SQL for the query command
Status: live (since 1.0.0)
Source: cli/commands/query_command.ts:37 @f4b3f49e
Acceptance (EARS):
- AC-013.1 If `sqlanvil query` is run with no sql argument, the CLI shall print an error containing `Provide a SQL query, e.g. sqlanvil query "select * from actions".` on stderr, run no query, and exit with code 1.
- AC-013.2 If the sql argument is an empty string, the CLI shall print the same error on stderr, run no query, and exit with code 1.
- AC-013.3 When the query command is given one positional argument, the CLI shall take it as the SQL and read the artifacts under the current directory.
Errors: QUERY_SQL_REQUIRED (contracts/errors.yaml)
Tests: T-013.1 [integration], T-013.2 [integration], T-013.3 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-014 Return 64-bit integers as JSON-safe values
Status: live (since 1.0.0)
Source: cli/api/dbadapters/duckdb_artifacts.ts:58 @f4b3f49e
Acceptance (EARS):
- AC-014.1 When a query over the artifacts returns a 64-bit integer value between -9007199254740991 and 9007199254740991, the artifact query shall return it as a number.
- AC-014.2 When a query over the artifacts returns a 64-bit integer value outside that range, the artifact query shall return it as its decimal string.
Errors: -
Tests: T-014.1 [integration], T-014.2 [integration]  (test-cases/artifacts.yaml)
Traces: commit a96f9958

### FR-015 Open a fresh in-memory DuckDB for each artifact query
Status: live (since 1.0.0)
Source: cli/api/dbadapters/duckdb.ts:40 @f4b3f49e
  cli/api/dbadapters/duckdb_artifacts.ts:66 @f4b3f49e
Acceptance (EARS):
- AC-015.1 When `sqlanvil query` runs, the query command shall run the SQL in a new in-memory DuckDB database, so that a table created by one invocation is absent from the next and no database file is written.
- AC-015.2 The query command shall run the SQL as given, including statements that write files or load DuckDB extensions.
Errors: -
Edge cases: SQL that writes outside DuckDB memory (`COPY … TO`, `ATTACH`, `INSTALL`) → AC-015.2 (owner, 2026-11-22)
Tests: T-015.1 [integration], T-015.2 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-016 Redirect DuckDB's home directory when HOME is unset
Status: live (since 1.0.0)
Source: cli/api/dbadapters/duckdb.ts:58 @f4b3f49e
Acceptance (EARS):
- AC-016.1 If the HOME environment variable is unset, the DuckDB helper shall set DuckDB's `home_directory` to the system temporary directory before it runs the SQL.
Errors: -
Tests: T-016.1 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-017 Report a DuckDB binding that fails to load
Status: live (since 1.0.0)
Source: cli/api/dbadapters/duckdb.ts:11 @f4b3f49e
Acceptance (EARS):
- AC-017.1 If `@duckdb/node-api` fails to load, the DuckDB helper shall throw an error whose message is `This feature requires the optional "@duckdb/node-api" dependency, which failed to load: ` followed by the load error's message.
Errors: ARTIFACTS_SKIPPED (contracts/errors.yaml; when it reaches safeWriteArtifacts)
Tests: T-017.1 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-018 Summarize the artifacts with the inspect command
Status: verified
Source: cli/commands/inspect_command.ts:23 @d6310e44
  cli/commands/inspect_command.ts:26 @d6310e44
  cli/commands/inspect_command.ts:38 @d6310e44
Acceptance (EARS):
- AC-018.1 When `sqlanvil inspect <project-dir>` runs on a project with a catalog, the inspect command shall print `Actions by type:` and then, in the table format of AC-011.1, the columns type and n (the number of actions of that type) ordered by type, and exit with code 0.
- AC-018.2 While a run is recorded, the inspect command shall then print an empty line and `Latest run (<run_status>): <s> succeeded, <f> failed, <w>ms` for the latest run, which is the run with the highest run_id in the `run_summary` view, with that view's run_status, or, when there is no `run_summary` view, the run with the highest run_id in the `runs` view, and where s is the number of that run's rows with status SUCCESSFUL, f the number with status FAILED, and w the latest end_millis minus the earliest start_millis over that run's rows with non-zero start and end times, and 0 when no row has both.
- AC-018.3 When the latest run has rows with status FAILED, the inspect command shall then print an empty line, `Failures:` and, in the table format of AC-011.1, the readable_name and error_message of the first 20 of them in readable_name order.
- AC-018.4 If no run is recorded (there is neither a `run_summary` nor a `runs` view), the inspect command shall print an empty line and `No runs recorded yet.` after the actions table.
- AC-018.5 When the latest run has no action results, the inspect command shall report it as the latest run with 0 succeeded, 0 failed and 0ms.
Errors: -
Edge cases: a latest run with a skipped or disabled action → AC-018.2 (E-001); a run with no action results → AC-018.5 (E-002); more than 20 failures → AC-018.3 (E-007)
Tests: T-018.1 [integration], T-018.2 [integration], T-018.3 [integration], T-018.4 [integration], T-018.5 [integration], T-018.6 [integration], T-018.7 [integration], T-018.8 [integration]  (test-cases/artifacts.yaml)
Traces: UJ-01

### FR-019 Print the inspect summary as JSON
Status: verified
Source: cli/commands/inspect_command.ts:34 @d6310e44
Acceptance (EARS):
- AC-019.1 When `sqlanvil inspect <project-dir> --json` runs on a project with a catalog and a recorded run, the inspect command shall print on stdout one JSON object, indented four spaces, with `actionsByType` (type and n per type, ordered by type), `latestRun` (run_id, run_status, succeeded, failed and wall_ms of the latest run as AC-018.2 defines it, wall_ms computed as in AC-018.2) and `failures` (readable_name and error_message of the first 20 FAILED rows of that run in readable_name order), and exit with code 0.
- AC-019.2 If no run is recorded (AC-018.4), the inspect command shall print `latestRun` as null and `failures` as an empty array.
- AC-019.3 When the latest run has no action results, the inspect command shall print it as `latestRun` with succeeded 0, failed 0 and wall_ms 0, and `failures` as an empty array.
Errors: -
Edge cases: a latest run with a skipped or disabled action → AC-019.1 (E-001); a run with no action results → AC-019.3 (E-002); more than 20 failures → AC-019.1 (E-007)
Tests: T-019.1 [integration], T-019.2 [integration], T-019.3 [integration], T-019.4 [integration], T-019.5 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-020 Write the HTML catalog with the docs command
Status: live (since 1.0.0)
Source: cli/commands/docs_command.ts:17 @f4b3f49e
  cli/commands/docs_command.ts:19 @f4b3f49e
Acceptance (EARS):
- AC-020.1 When `sqlanvil docs <project-dir>` runs on a project with a catalog, the docs command shall write the rendered catalog page to `<project-dir>/target/docs/index.html`, creating `target/docs/` when missing, print `Wrote catalog to <absolute path of index.html>` on stdout, where the absolute path is `<project-dir>` made absolute with its symlinks left unresolved, and exit with code 0.
- AC-020.2 When `target/docs/index.html` already exists, the docs command shall replace it.
- AC-020.3 The docs command shall stamp the page with the time it ran, as an ISO 8601 UTC timestamp, in its `generated <timestamp>` text.
Errors: -
Tests: T-020.1 [integration], T-020.2 [integration], T-020.3 [integration]  (test-cases/artifacts.yaml)
Traces: UJ-01; `target/docs/index.html`

### FR-021 Build the docs catalog model from the artifacts
Status: verified
Source: cli/api/commands/docs.ts:42 @d6310e44
Acceptance (EARS):
- AC-021.1 When buildDocsModel is called with the artifact views, the docs builder shall return one model per actions row, ordered by type and then readable_name, each with its readable name, type, tags parsed from the tags JSON, description, and `dependsOn`: the to_readable of every dependencies row whose from_target_key is the model's target_key, in the order of the dependencies file.
- AC-021.2 The docs builder shall return a summary with the number of models and, per type, the number of models of that type, sorted by type, and `generatedAt` set to the timestamp it was given.
- AC-021.3 While a `run_summary` or a `runs` view is given, the docs builder shall set `latestRun` to the run_id and run_status of the latest run as AC-018.2 defines it, a run with no action results included, set each model's status to the status of the `runs` row of that run whose target_key is the model's target_key, and give a model with no row in that run no status.
- AC-021.4 If neither a `run_summary` nor a `runs` view is given, the docs builder shall return no `latestRun` and no model status.
- AC-021.5 If an action's tags value is not valid JSON, the docs builder shall give that model an empty tag list.
- AC-021.6 The docs builder shall return one column entry per columns row, ordered by readable_name and then column_name, with its readable name, column name and description.
Errors: -
Edge cases: two targets with one readable name → AC-021.1, AC-021.3 (E-004); a run with no action results → AC-021.3 (E-002); a model absent from the latest run shows no status, even when an earlier run recorded one (owner, 2026-11-22)
Tests: T-021.1 [integration], T-021.2 [integration], T-021.3 [integration], T-021.4 [integration], T-021.5 [integration], T-021.6 [integration], T-021.7 [integration], T-021.8 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-022 Render the docs catalog as one self-contained HTML page
Status: live (since 1.0.0)
Source: cli/api/commands/docs.ts:127 @f4b3f49e
  cli/api/commands/docs.ts:32 @f4b3f49e
Acceptance (EARS):
- AC-022.1 When renderDocsHtml is called with a catalog model, the docs renderer shall return one HTML document titled `SQLAnvil catalog` whose styles and script are inline and which has no `src=` or `href=` reference.
- AC-022.2 The docs renderer shall print a meta line of `<total> models — <n> <type>, …` (the summary per type, comma-separated), then ` &middot; `, the run line, ` &middot; generated ` and the model's generatedAt.
- AC-022.3 The docs renderer shall write the run line as `Last run: <strong><status></strong> (run <run id>)` when the model has a latest run, and `No runs recorded yet.` when it has none.
- AC-022.4 The docs renderer shall write one models-table row per model with its readable name in `<code>`, its type, each tag as `<span class="tag">`, a status badge (`badge ok` for SUCCESSFUL, `badge fail` for FAILED, `badge muted` for any other status, none when the model has no status), each dependsOn name in `<code>` joined by `<br>`, and its description.
- AC-022.5 The docs renderer shall escape `&`, `<`, `>` and `"` in every model, column and meta value it writes.
- AC-022.6 If the model has no columns, the docs renderer shall write the single columns-table row `No documented columns.`.
- AC-022.7 The docs renderer shall give each models-table row a `data-search` attribute holding the lower-cased readable name, type and tags joined by spaces, and an inline `filterModels` script that hides the rows whose `data-search` does not contain the lower-cased filter text.
Errors: -
Tests: T-022.1 [integration], T-022.2 [integration], T-022.3 [integration], T-022.4 [integration], T-022.5 [integration], T-022.6 [integration], T-022.7 [integration]  (test-cases/artifacts.yaml)
Traces: -

### FR-023 Run a warehouse query through an adapter
Status: live (since 1.0.0)
Source: cli/api/commands/query.ts:5 @f4b3f49e
Acceptance (EARS):
- AC-023.1 When query.run is called with a database adapter, SQL and options, the query API shall call the adapter's execute once with the SQL unchanged and the options `interactive: true` and the given rowLimit and byteLimit, and resolve with the result's rows.
- AC-023.2 If the adapter's execute rejects, the query API shall reject with the same error.
- AC-023.3 When the promise query.run returned is cancelled, the query API shall call the cancel handler the adapter registered through `onCancel`. A cancel that arrives before the adapter registers its handler is delivered as soon as the handler is registered (cli/api/utils/cancellable_promise.ts, owner, 2026-11-22).
- AC-023.4 When query.run is given `options.compileConfig`, the query API shall ignore it.
Errors: -
Tests: T-023.1 [integration], T-023.2 [integration], T-023.3 [integration], T-023.4 [integration]  (test-cases/artifacts.yaml)
Traces: exported as `query` from `sa/cli/api` (cli/api/index.ts:8)

### FR-024 Evaluate a query through an adapter
Status: live (since 1.0.0)
Source: cli/api/commands/query.ts:29 @f4b3f49e
Acceptance (EARS):
- AC-024.1 When query.evaluate is called with a database adapter and SQL, the query API shall call the adapter's evaluate with the SQL unchanged and resolve with the first evaluation it returns.
Errors: -
Tests: T-024.1 [integration]  (test-cases/artifacts.yaml)
Traces: exported as `query` from `sa/cli/api` (cli/api/index.ts:8)
