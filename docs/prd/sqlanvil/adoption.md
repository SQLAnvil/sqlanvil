# Adoption map

| Area | State | Boundary |
|---|---|---|
| sqlx | not started | `sqlx/**` |
| compiler | not started | `core/*`, `core/compilation_sql/**` |
| actions | not started | `core/actions/**` |
| configs | not started | `protos/**` |
| cli | not started | `cli/*`, `cli/vm/**`, `cli/commands/compile_command.ts`, `cli/commands/format_command.ts`, `cli/commands/help_command.ts`, `cli/commands/index.ts`, `cli/commands/init_command.ts`, `cli/commands/init_creds_command.ts`, `cli/commands/install_command.ts`, `cli/commands/introspect_command.ts`, `cli/commands/migrate_dataform_command.ts`, `cli/commands/migrate_fix_command.ts`, `cli/commands/run_command.ts`, `cli/commands/test_command.ts`, `cli/commands/validate_command.ts` |
| execution | not started | `cli/api/*`, `cli/api/goldens/**`, `cli/api/utils/**`, `cli/api/commands/base_worker.ts`, `cli/api/commands/build*`, `cli/api/commands/compile.ts`, `cli/api/commands/compile_copy_filter*`, `cli/api/commands/environments*`, `cli/api/commands/jit/**`, `cli/api/commands/prune*`, `cli/api/commands/run.ts`, `cli/api/commands/run_*`, `cli/api/commands/state.ts`, `cli/api/commands/test.ts`, `cli/api/commands/test_test.ts`, `cli/api/dbadapters/execution_sql.ts`, `cli/api/dbadapters/index.ts`, `cli/api/dbadapters/tasks.ts` |
| bigquery | not started | `cli/api/dbadapters/bigquery.ts`, `cli/api/dbadapters/bigquery_execution_sql.ts`, `cli/api/dbadapters/bigquery_test.ts`, `cli/api/commands/bigquery_residue*` |
| postgres | not started | `cli/api/dbadapters/postgres*`, `cli/api/dbadapters/supabase*` |
| mysql | not started | `cli/api/dbadapters/mysql.ts`, `cli/api/dbadapters/mysql_execution_sql.ts` |
| sources | not started | `cli/api/dbadapters/bigquery_extract*`, `cli/api/dbadapters/mysql_extract.ts`, `cli/api/dbadapters/extract_load*`, `cli/api/commands/connection_credentials*`, `cli/api/commands/introspect*` |
| files | not started | `cli/api/dbadapters/duckdb_export*`, `cli/api/dbadapters/duckdb_import*`, `cli/api/dbadapters/export_*`, `cli/api/dbadapters/import_*` |
| artifacts | adopted | `cli/commands/artifact_views.ts`, `cli/commands/docs_command.ts`, `cli/commands/inspect_command.ts`, `cli/commands/query_command.ts`, `cli/api/commands/artifact*`, `cli/api/commands/docs*`, `cli/api/commands/query.ts`, `cli/api/dbadapters/duckdb.ts`, `cli/api/dbadapters/duckdb_artifacts.ts` |
| validate | not started | `cli/api/commands/validate*` |
| scripts | not started | `cli/api/commands/script*` |
| project-setup | not started | `cli/api/commands/agents_md.ts`, `cli/api/commands/credentials*`, `cli/api/commands/init*`, `cli/api/commands/install.ts`, `cli/api/commands/migrate_*` |
| release | adopted | `packages/**`, `version.bzl`, `scripts/release_github`, `scripts/update_version`, `scripts/regenerate_docs` |

<!-- Seen while extracting artifacts (f4b3f49e), for the areas they belong to:
- cli: `compile` writes the catalog with safeWriteArtifacts only when the compiled graph has no errors, and not with `—no-artifacts`; warnings go to stdout (cli/commands/compile_command.ts:178-181).
- cli: `run` writes the catalog and a run-history file after every run, with runId Date.now(), unless `—no-artifacts`. The "Artifacts skipped" warning goes to stderr in `—json` mode and to stdout otherwise (cli/commands/run_command.ts:447-453).
- cli: the `—artifacts` boolean option defaults to true and `—no-artifacts` negates it (cli/common_options.ts:155-161).
- cli: the `project-dir` positional defaults to `.` and is resolved to an absolute path with `~` expanded (cli/common_options.ts:38-43, cli/util.ts:11-13). query, inspect and docs use the variant that does not check the directory exists.
- cli: the yargs fail handler prints `"sqlanvil encountered an error: <first line>"` and the stack, then exits 1. An unhandled rejection prints "Unhandled promise rejection: …" (cli/index.ts:7-34).
- cli: the command runner flushes stdout and stderr before process.exit, so large `query —json` output is not cut off (cli/yargswrapper.ts:70-78).
- cli: NO_COLOR=1/true/yes turns off the ANSI colours of printError, printSuccess and printWarning. printError and printWarning write to stderr, print and printSuccess to stdout (cli/console.ts:14-46, 169-183).
- files: withDuckdb, runAsync and allAsync in duckdb.ts are shared with duckdb_export.ts and duckdb_import.ts. FR-015, FR-016 and FR-017 therefore also hold for imports and exports (cli/api/dbadapters/duckdb_export.ts:1, duckdb_import.ts:1).
- compiler: the target_key format (JSON with sorted keys) and the readable-name format come from core/targets.ts:5-21 and common/strings/stringifier.ts:8-16.
- execution: SKIPPED and DISABLED action results carry no timing (cli/api/commands/run.ts:350-354, 396-401, 428-431). This is the source of E-001.
- execution: `sa/cli/api` exports the query module as part of the programmatic API (cli/api/index.ts:8, 20). Nothing in the CLI calls query.run or query.evaluate.
- cli/packaging: the README's query, inspect and docs sections are generated from the command definitions (cli/update_readme.ts, `//cli:readme_generated_test`). `@duckdb/node-api` is an external of the CLI package (packages/@sqlanvil/cli/BUILD:32).
-->

<!-- Seen while extracting release (9cabe4e4), for the areas they belong to:
- compiler: core/BUILD:9-17 stamps core/version.ts from core/version.ts.tmpl with `version` = SQLANVIL_VERSION and `dataformVersion` = DF_VERSION; core/index.ts:42 exports `version`.
- cli: `--version` prints `sqlanvil <version> (Dataform core <dataformVersion>)` (cli/yargswrapper.ts:82).
- cli: cli/vm/compile.ts:125-133 reads the CLI's own version from the package.json beside the bundle ("0.0.0" when it cannot); its comment at :136 says the core floor is NOT derived from the CLI's version (since 1.33.1, upstream #2376), so prd.md section 9's "at least the CLI's major.minor.0" looks stale.
- cli: the stateless install of a pinned `@sqlanvil/core` from npm at compile time lives in cli/vm (compile.ts); its npm-registry dependency belongs to cli.
- cli: `scripts/run` wraps `bazel run //packages/@sqlanvil/cli:bin -- "$@"`; `testing/resolver-patch.js` resolves `sa/...` for the dev binary.
- cli/compiler: unit tests `cli/tests/package_test.ts` and `core/package_test.ts` already check the generated manifests and the bundle.d.ts imports.
- compiler: `core/utils.ts` nativeRequire loads `@duckdb/node-api` through a non-literal require, which the rollup config relies on (AC-031.4).
- docs tooling (no area): `tools/typedoc/postprocess.py`, `tools/protoc-gen-doc/build-image.sh`, `typedoc.json`.
- process (no area): the release steps around the scripts live in SQLAnvil/docs `npm_publishing.md` (core alone first, then cli, then release_github, then the section 3.6 sync).
-->
