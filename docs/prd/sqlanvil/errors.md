<!-- Format: references/prd-format.md, "errors.md".
Entry lines in order: Detected, Classification, Confirmed, Touches, Evidence (at most 20 lines, continuation lines indented two spaces), Diagnosis, Resolution, Recurrence of. -->

# Error ledger

### E-001 inspect wall time counts skipped and disabled actions from epoch zero
Detected: 2026-11-22, adoption extract of artifacts (cli/commands/inspect_command.ts:29 @f4b3f49e)
Classification: code bug
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-018, FR-019
Evidence: characterization suite, 2026-11-22, `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` @984785d8
  T-018.5: line 10 is "Latest run (SUCCESSFUL): 1 succeeded, 0 failed, 1400ms" where 400ms is intended
  T-019.3: latestRun.wall_ms is 1400 where 400 is intended
Diagnosis: inspect computes wall_ms as `max(end_millis) - min(start_millis)` over every row of the latest run. runRows writes 0 for start_millis and end_millis when an action result has no timing (artifact_rows.ts:78-81, 171-172). The runner records SKIPPED and DISABLED action results with no timing (cli/api/commands/run.ts:350-354, 396-401, 428-431). So one such action makes min(start_millis) 0, and inspect prints the latest end time in epoch milliseconds (about 1.7e12 ms) as the run's wall time. Two things say it should not. The sibling code treats 0 as missing: duration_millis is set only when both times are non-zero (artifact_rows.ts:182). And the command describes this figure as "the latest run's status, timing" (inspect_command.ts:65; cli/README.md:402 "wall time").
Resolution: T-018.5 [integration], PRD 1.0.4, fixed in a75ad89b
Recurrence of: -

### E-002 A run with no action results does not show in inspect or docs
Detected: 2026-11-22, adoption extract of artifacts (cli/api/commands/artifact_rows.ts:168 @f4b3f49e)
Classification: code bug
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-005, FR-018, FR-019, FR-021
Evidence: characterization suite, 2026-11-22, `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` @984785d8
  T-005.9: `select distinct run_id, run_status from runs where run_id = 300` returns 0 rows
  T-018.6: line 10 is "Latest run (FAILED): 1 succeeded, 1 failed, 600ms", the previous run 123, not the latest run 200
  T-019.4: latestRun.run_id is 123 (FAILED, 1 succeeded, 1 failed, 600) where run 200 is intended
  T-021.8: latestRun.runId is 123 where run 200 is intended
Diagnosis: The run id and run status are stored only in per-action rows (artifacts.ts:29-39, artifact_rows.ts:170-185). A run result with no action results therefore writes `run_<id>.parquet` with zero rows (artifacts.ts:64-70, duckdb_artifacts.ts:30-32), and `max(run_id)` never sees that run (inspect_command.ts:30, 36; docs.ts:63). inspect and docs then report the previous run as "Latest run" or "Last run", or "No runs recorded yet." when it is the only run. The docs say otherwise: inspect summarizes "the latest run's status" (inspect_command.ts:65, cli/README.md:402), run "adds a run-history entry" (cli/README.md:53), and docs shows "last-run status" (docs.ts:5).
Resolution: T-018.6 [integration], PRD 2.0.1, fixed in 8e627876
Recurrence of: -

### E-003 An empty artifact file does not keep its columns' types
Detected: 2026-11-22, adoption extract of artifacts (cli/api/dbadapters/duckdb_artifacts.ts:31 @f4b3f49e)
Classification: code bug
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-006
Evidence: characterization suite, 2026-11-22, `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` @984785d8
  T-006.1: every column of the empty actions file has type JSON; the file written from rows has VARCHAR, and BOOLEAN for disabled
Diagnosis: The comments say an empty rowset produces a "correctly-typed 0-row Parquet" (artifacts.ts:14; duckdb_artifacts.ts:16-18). The writer only has column names, though. It writes one all-null JSON row and filters it out with `WHERE false`, so DuckDB's read_json_auto infers each column from nulls alone. Those columns cannot get the BOOLEAN, BIGINT and VARCHAR types the same columns get from real rows (disabled, run_id, start_millis and the rest). Two things need a run to confirm: the exact type DuckDB infers, and whether a `runs` glob that mixes such a file with typed files fails to read.
Resolution: T-006.1 [integration], PRD 2.0.1, fixed in 08deca28
Recurrence of: -

### E-004 docs indexes models by their readable name
Detected: 2026-11-22, adoption extract of artifacts (cli/api/commands/docs.ts:76 @f4b3f49e)
Classification: code bug
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-021
Evidence: characterization suite, 2026-11-22, `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` @984785d8
  T-021.7: the a.b.c table's model has status FAILED, the status of the other target that reads as a.b.c, where its own SUCCESSFUL is intended
Diagnosis: buildDocsModel keys each model's last-run status (docs.ts:75-77, 103) and its depends-on list (docs.ts:81-87, 104) by readable_name, even though every row carries target_key. core/targets.ts:12-13 says of targetAsReadableString: "This is an ambiguous transformation, multiple targets may map to the same string and it should not be used for indexing. Use targetStringifier instead." Two targets with the same readable name share one status and one merged dependency list. For example, database a, schema b, name c and schema a.b, name c both read as a.b.c.
Resolution: T-021.7 [integration], PRD 1.0.4, fixed in 85336e90
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
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-001, FR-010
Evidence: characterization suite, 2026-11-22, `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` @984785d8
  T-001.4: writeArtifacts into a directory named o'brien-… rejects with `Parser Error: syntax error at or near "brien"`
  T-010.5: the same rejection while writing the project's artifacts, so the query never runs
Diagnosis: Project and temporary paths go into DuckDB SQL inside single quotes without escaping (cli/api/dbadapters/duckdb_artifacts.ts:38, 70; cli/api/dbadapters/duckdb.ts:59 @f4b3f49e). A path holding a `'` ends the string literal early, so the write fails and is skipped with a warning (FR-008), and query, inspect and docs fail on that project. The owner confirmed it a bug on 2026-11-22.
Resolution: T-001.4 [integration], PRD 2.0.1, fixed in 81a1434f
Recurrence of: -

### E-007 inspect lists an arbitrary 20 of more than 20 failures
Detected: 2026-11-22, confirmation of FR-018 (open question Q-10)
Classification: code bug
Confirmed: 2026-11-23, "Confirm the class (form)"
Touches: FR-018, FR-019
Evidence: characterization suite, 2026-11-22, at eeface71
  T-018.3 passes: with the case's 21 rows DuckDB returned the FAILED rows in readable_name order, so the case cannot show the missing ORDER BY; it stays a plain test, not known-failing (owner, 2026-11-22)
Diagnosis: inspect selects the latest run's FAILED rows with `limit 20` and no ORDER BY (cli/commands/inspect_command.ts:34-38 @f4b3f49e), so when there are more than 20 failures, which 20 it prints, and in what order, is up to DuckDB. The owner confirmed it a bug on 2026-11-22.
Resolution: T-018.7 [integration], PRD 1.0.4, fixed in 98141606
Recurrence of: -

### E-008 Every Bazel job of the prd-toolkit CI workflow fails: the runner has no `~/.npmrc`
Detected: 2026-11-23, CI run 45205148047 on PR #65
Classification: environment
Confirmed: 2026-11-23, "Confirm the class (form)"
URL: https://github.com/SQLAnvil/sqlanvil/actions/runs/45205148047
Evidence: PR #65, workflow prd-toolkit, run 45205148047 (2026-11-23), at fdc5ffa6
  Failed: standards-1, standards-2, standards-3, test-unit, test-integration, test-warehouse
  Passed: prd-lint, prd-trace
  test-unit, `bazel test //... --test_tag_filters=-integration --build_tests_only`:
    Downloading https://releases.bazel.build/7.3.2/release/bazel-7.3.2-linux-x86_64...
    File ".../external/aspect_rules_js~/npm/extensions.bzl", line 100, column 53, in _npm_lock_imports_bzlmod
      home_npmrc = parse_npmrc(module_ctx.read(home_npmrc_path))
    Error in read: java.io.FileNotFoundException: /home/runner/.npmrc (No such file or directory)
    ERROR: error evaluating module extension npm in @@aspect_rules_js~//npm:extensions.bzl
    ERROR: Couldn't start the build. Unable to run tests
    ##[error]Process completed with exit code 48.
  standards-1, eslint over the .ts files:
    Error in read: java.io.FileNotFoundException: /home/runner/.npmrc (No such file or directory)
    ERROR: Build failed. Not running target
    ##[error]Process completed with exit code 123.
Diagnosis: The code and the PRD agree; the CI runner lacks what the PRD says a runner needs. testing.md, Harness, Tools on the runner: "a `~/.npmrc` file, empty if nothing else, because `MODULE.bazel` sets `use_home_npmrc = True` and rules_js fails when the file is missing". MODULE.bazel:34 sets `use_home_npmrc = True` (from upstream, 65341c8d). GitHub's ubuntu-latest runner has no `~/.npmrc`, and the workflow that `prd hooks ci --github` generated (prd-toolkit 0.8.14, prdlint/hooks.py render_github) runs each Levels or standards command straight after checkout and setup-uv, with no step that creates one; the generator has no way to add a setup step, and a Levels command must be one simple command. Every Bazel job therefore stops while loading the npm module extension, before any test or linter runs; prd-lint and prd-trace, which do not use Bazel, pass. Reproduced in this session: the same `FileNotFoundException` for /Users/ihistand/.npmrc stopped a local `bazel build` until an empty file was created. Nothing in the repository needs a home .npmrc since scripts/create_npmrc (Google's internal registry) was deleted in 95156a78. Not yet seen, because this error hides them: whether the warehouse job can reach BigQuery (its credential is only on the owner's machine) and whether eslint and prettier pass over every .ts file.
Resolution: -, PRD 1.0.1, CI run https://github.com/SQLAnvil/sqlanvil/actions/runs/45211614726
Recurrence of: -

### E-009 The CI eslint job cannot load `typescript-eslint`
Detected: 2026-11-23, CI run 45207610173 on PR #65, job standards-1
Classification: environment
Confirmed: 2026-11-23, "Confirm the class (form)"
URL: https://github.com/SQLAnvil/sqlanvil/actions/runs/45207610173
Evidence: PR #65, workflow prd-toolkit, run 45207610173 (2026-11-23), at d865b97e, job standards-1
  INFO: Running command line: bazel-bin/eslint_/eslint '**/*.ts' ./cli/api/commands/agents_md.ts ...
  Error: Cannot find module 'typescript-eslint'
  Require stack:
  - /home/runner/work/sqlanvil/sqlanvil/eslint.config.js
      at Module._resolveFilename (/home/runner/work/sqlanvil/sqlanvil/testing/resolver-patch.js:27:14)
      at Object.<anonymous> (/home/runner/work/sqlanvil/sqlanvil/eslint.config.js:8:18)
  ##[error]Process completed with exit code 123.
Diagnosis: The PRD's eslint standards row is incomplete for a fresh runner. prd.md section 5: "`scripts/bazel-ci run //:eslint -- '**/*.ts'`". eslint.config.js:8 requires `typescript-eslint` from the workspace node_modules, which a fresh checkout does not have. scripts/lint, where the row came from, prepares it first ("Type-aware lint rules need the npm types in node_modules and the generated sources in bazel-bin": `bazel run -- @pnpm//:pnpm --dir "$PWD" install --frozen-lockfile` and `bazel build //protos:ts //core:version`); the row copied only the eslint line, so the generated standards-1 job runs eslint with no node_modules. The code and its config are right; the CI command the PRD gives is not.
Resolution: -, PRD 1.0.2, CI run https://github.com/SQLAnvil/sqlanvil/actions/runs/45211614726
Recurrence of: -

### E-010 The CI prettier check finds 8 unformatted .ts files
Detected: 2026-11-23, CI run 45207610173 on PR #65, job standards-2
Classification: standard
Confirmed: 2026-11-23, "Confirm the class (form)"
URL: https://github.com/SQLAnvil/sqlanvil/actions/runs/45207610173
Evidence: PR #65, workflow prd-toolkit, run 45207610173 (2026-11-23), at d865b97e, job standards-2
  INFO: Running command line: bazel-bin/prettier_/prettier --ignore-path .prettierignore --check ./cli/api/commands/agents_md.ts ...
  Checking formatting...
  [warn] common/protos/index.ts
  [warn] tests/prd/artifacts/cli.spec.ts
  [warn] tests/prd/artifacts/docs_model.spec.ts
  [warn] tests/prd/artifacts/duckdb_fail_child.ts
  [warn] tests/prd/artifacts/fixtures.ts
  [warn] tests/prd/artifacts/helpers.ts
  [warn] tests/prd/artifacts/known_failing.ts
  [warn] tests/prd/artifacts/writer.spec.ts
  [warn] Code style issues found in 8 files. Run Prettier with --write to fix.
  ##[error]Process completed with exit code 123.
Diagnosis: The code breaks an enforced standard of section 5: "`scripts/bazel-ci run //:prettier -- --ignore-path .prettierignore --check` (files changed on the branch, `scripts/lint`)" with rules in `.prettierrc`. 8 files are not prettier-formatted: common/protos/index.ts (existing code, outside every adopted area) and 7 files of the characterization suite under tests/prd/artifacts/ (cli.spec.ts, docs_model.spec.ts, duckdb_fail_child.ts, fixtures.ts, helpers.ts, known_failing.ts, writer.spec.ts), which prd-tester wrote. The row and the generated job also disagree on scope: the row says files changed on the branch, while the generated standards-2 job checks every tracked .ts file, which is why common/protos/index.ts shows. The owner chooses which side changes: the code (format the 8 files) or the row (its scope).
Resolution: -, PRD 1.0.2, CI run https://github.com/SQLAnvil/sqlanvil/actions/runs/45211614726
Recurrence of: -

### E-011 The CI README job passes `./cli/README.md` to `bazel test` as a target
Detected: 2026-11-23, CI run 45207610173 on PR #65, job standards-3
Classification: environment
Confirmed: 2026-11-23, "Confirm the class (form)"
URL: https://github.com/SQLAnvil/sqlanvil/actions/runs/45207610173
Evidence: PR #65, workflow prd-toolkit, run 45207610173 (2026-11-23), at d865b97e, job standards-3
  run: git ls-files -z --format='./%(path)' -- ':(glob)cli/README.md' ':(exclude).prd-toolkit' | xargs -0 -r scripts/bazel-ci test //cli:readme_generated_test
  ERROR: Skipping './cli/README.md': invalid target name './cli/README.md': target names may not contain '.' as a path segment
  ERROR: invalid target name './cli/README.md': target names may not contain '.' as a path segment
  ERROR: Build did NOT complete successfully
  ERROR: Couldn't start the build. Unable to run tests
  ##[error]Process completed with exit code 123.
Diagnosis: The code and the README test are right; the CI command built from the PRD row is wrong. prd.md section 5: Object `cli/README.md`, command "`scripts/bazel-ci test //cli:readme_generated_test`". The generator (prd-toolkit 0.8.14, prdlint/hooks.py ci_jobs) runs every standards row as `git ls-files -z --format='./%(path)' -- <the Object glob> | xargs -0 -r <command>`, so it appends `./cli/README.md` to `bazel test`, which reads it as a target and refuses it ("target names may not contain '.' as a path segment"). The row's command takes no file arguments, and the generator has no way to say so; that is also a prd-toolkit gap to report to its coordinator.
Resolution: -, PRD 1.0.2, CI run https://github.com/SQLAnvil/sqlanvil/actions/runs/45211614726
Recurrence of: -

### E-012 The CI unit and warehouse jobs fail to build without `test_credentials/bigquery.json`
Detected: 2026-11-23, CI run 45207610173 on PR #65, jobs test-unit and test-warehouse
Classification: environment
Confirmed: 2026-11-23, "Confirm the class (form)"
URL: https://github.com/SQLAnvil/sqlanvil/actions/runs/45207610173
Evidence: PR #65, workflow prd-toolkit, run 45207610173 (2026-11-23), at d865b97e
  test-unit, `scripts/bazel-ci test //... --test_tag_filters=-integration --build_tests_only`:
    ERROR: cli/BUILD:79:14: Middleman _middlemen/cli_Sindex_Uhelp_Utest_U_Sindex_Uhelp_Utest-runfiles failed: missing input file '//test_credentials:bigquery.json'
    ERROR: cli/BUILD:79:14: Middleman _middlemen/cli_Sutil_Utest_U_Sutil_Utest-runfiles failed: missing input file '//test_credentials:bigquery.json'
    //cli:index_help_test    FAILED TO BUILD
    ##[error]Process completed with exit code 1.
  test-warehouse, `scripts/bazel-ci test //tests/integration/... //tests/api/... --test_tag_filters=integration --build_tests_only`:
    ERROR: tests/integration/BUILD:20:14: Middleman _middlemen/tests_Sintegration_Sbigquery.spec_U_Sbigquery.spec-runfiles failed: missing input file '//test_credentials:bigquery.json'
    //tests/integration:bigquery.spec    FAILED TO BUILD
    ##[error]Process completed with exit code 1.
Diagnosis: The CI runner has no BigQuery credential, which the build needs even at the unit level. testing.md, Harness, Lifecycle: "The BigQuery spec uses a real GCP project through `test_credentials/bigquery.json`"; operations.md, Secrets: "It is kept only on the owner's machine and held by the owner (Ivan Histand); it is in no CI system and no secret store". cli/BUILD:79 `ts_test_suite(name = "tests")` lists `//test_credentials:bigquery.json` in the `data` of every test in it, so `//cli:index_help_test` and `//cli:util_test`, untagged and so in the unit level, fail to build without the file; tests/integration/BUILD:20 does the same for bigquery.spec in the warehouse level. The file is git-ignored and absent on the runner (this worktree has only test_credentials/BUILD too). Not yet seen: whether the warehouse level's Docker specs pass on the runner once they build.
Resolution: -, PRD 1.0.2, CI run https://github.com/SQLAnvil/sqlanvil/actions/runs/45211614726
Recurrence of: -

### E-013 version.bzl is listed in the core and sample-extension packages but never reaches the tarball
Detected: 2026-11-25, adoption extract of release (packages/@sqlanvil/core/BUILD:125 @9cabe4e4)
Classification: not a defect
Confirmed: 2026-11-26, "Option 2.... Not a defect"
Touches: FR-026, FR-035
Explanation: I ran the release suite's tarball tests on the current code and asked Bazel what the two package targets take as inputs. The tarballs are right: core holds exactly the 11 files the PRD lists and the sample extension its 3, and neither holds version.bzl, so every tarball test passes. But both package targets still list version.bzl as an input, a leftover from before the build-system migration, which the packaging step now drops without a word. You recorded that you want each package to list only what it ships, but that wish sits in the Edge cases notes, not in any acceptance criterion, so no test can fail on it: the PRD is silent where it matters, which makes this a spec gap rather than a code bug (the code breaks no AC) or not a defect (it does contradict what you said you want). Do you want the PRD to require that a package target lists only the files its tarball ships, checked by a test, so the builder then removes the leftover? That keeps it a spec gap, fixed by a new AC and a build. Or is the tarball being right enough? Then it is not a defect: E-013 closes, and the Edge cases note is reworded so it no longer promises the removal.
Diagnosis: Root cause: `//packages/@sqlanvil/core:package` (packages/@sqlanvil/core/BUILD:125) and `//packages/sample-extension:package` (packages/sample-extension/BUILD:69) list `//:version.bzl` in their srcs; rules_js `npm_package`'s default `include_srcs_packages = ["./**"]` drops a root-package file, so it never reaches the tarball. Runs on HEAD 755090f0: (1) `scripts/bazel-ci test //tests/prd/release:tarballs.spec --test_tag_filters=integration --build_tests_only --test_output=all --nocache_test_results` printed `Executed 1 out of 1 test: 1 test passes.` (T-026.1, T-026.2, T-035.4, T-035.5 pass); (2) `scripts/bazel-ci query "labels(srcs, <target>)"` printed `//:version.bzl` for both targets; (3) the built tarballs hold 11 and 3 entries, none with version.bzl. AC-026.1 ("…containing the entries `package/bundle.js`, … `package/package.json` and `package/README.md`") and AC-035.5 hold. The intent is only in FR-026 Edge cases: "`//:version.bzl` is listed in the package's deps but is not in the tarball (E-013); intended: a package lists only what it ships, so the dead dep goes (owner, 2026-11-25)", and the same in FR-035; no AC, contract or test case states it. Searched: FR-025, FR-026, FR-035 ACs, test-cases/release.yaml, contracts/errors.yaml.
Resolution: not a defect: the tarballs hold exactly what AC-026.1 ("…containing the entries `package/bundle.js`, `package/bundle.d.ts`, … `package/package.json` and `package/README.md`") and AC-035.5 list, with no version.bzl; the leftover `//:version.bzl` input of the two package targets changes nothing a user sees, and the owner chose to keep it (2026-11-26)
Recurrence of: -

### E-014 release_github can tag a later commit instead of the `release: SQLAnvil X.Y.Z` commit
Detected: 2026-11-25, adoption extract of release (scripts/release_github:47 @9cabe4e4)
Classification: unclassified
Touches: FR-038
Diagnosis: read from the code, not reproduced. The release commit comes from `git log -1 --grep="release: SQLAnvil $VERSION" --grep="SQLANVIL_VERSION.*$VERSION"`. The two patterns are ORed and the newest match wins, so a later commit whose message mentions `SQLANVIL_VERSION … <version>` beats the release bump. A read-only `git log` at 9cabe4e4 with VERSION=1.33.0 shows it: the lookup returns 8d1e2bac, the 1.33.1 bump (its body has "SQLANVIL_VERSION 1.33.0 -> 1.33.1."), and not 9cfa341f "release: SQLAnvil 1.33.0". The script's comment says the release commit is "the 'release: SQLAnvil X.Y.Z' bump, else HEAD" (line 46). The runbook (npm_publishing.md §3.5) says it "finds the `release: SQLAnvil X.Y.Z` commit". A first-time tag would go on the wrong commit. When the tag already exists, the dry run's `Tag : … (commit …)` line still names the wrong commit.
Resolution: open, intended: release_github uses the newest `release: SQLAnvil X.Y.Z` commit; only when there is none, the newest `SQLANVIL_VERSION … X.Y.Z` commit; otherwise HEAD (owner, 2026-11-25; AC-038.1, AC-038.8)
Recurrence of: -

### E-015 release_github exits without its error message when version.bzl has no SQLANVIL_VERSION
Detected: 2026-11-25, adoption extract of release (scripts/release_github:22 @9cabe4e4)
Classification: unclassified
Touches: FR-036
Diagnosis: read from the code, not reproduced on the script. Line 23 is meant to print "could not read SQLANVIL_VERSION from version.bzl" when the version is empty. But the script runs under `set -euo pipefail`, and line 22 assigns `VERSION="${VERSION:-$(grep … | sed …)}"`. When grep matches nothing, pipefail makes the command substitution fail and errexit stops the script during the assignment. It exits 1 and prints nothing, so line 23's message can never appear. I checked this bash behaviour with a separate one-line snippet on /bin/bash 3.2 (not the script): the same assignment form exits 1 before the next line.
Resolution: open, intended: release_github prints `could not read SQLANVIL_VERSION from version.bzl` and exits 1 (owner, 2026-11-25; AC-036.7)
Recurrence of: -

### E-016 update_version aborts when DF_VERSION's patch is 0
Detected: 2026-11-25, adoption extract of release (scripts/update_version:14 @9cabe4e4)
Classification: code bug
Touches: FR-039
Explanation: I ran the script on a copy of version.bzl under bash 5 (Linux, in Docker). With version 3.1.0 it stopped with exit 1 and changed nothing; with 3.1.8 it wrote 3.1.9. On this Mac it fails before that, because the Mac grep has no -P option (exit 2). The PRD retired this requirement in 2.3.0: FR-039 is removed, and its note says the script is deleted, because the upstream version is set by hand at each sync. So the PRD is right and the repository is wrong: the script it says is gone is still there, and still broken. That makes it a code bug, not a spec gap: the PRD is not silent, it says the script goes. The fix is deleting scripts/update_version.
Diagnosis: Root cause: `((patch++))` at scripts/update_version:14 evaluates to the old patch; for patch 0 the arithmetic command returns status 1 and `set -e` (line 2) exits. Runs in a scratch clone at db48c058: `docker run debian:bookworm-slim bash scripts/update_version` (GNU bash 5.2.15) in a dir with `DF_VERSION = "3.1.0"` printed nothing and `exit=1`, file unchanged; with `DF_VERSION = "3.1.8"` it printed `Version updated to: 3.1.9`, `exit=0`. `/bin/bash scripts/update_version` (macOS bash 3.2, BSD grep) printed `grep: invalid option -- P` and `exit=2`. PRD: FR-039 `Status: removed (since 2.3.0)`; its Edge cases: `retired (owner, 2026-11-25, Q-15): DF_VERSION is set by hand at each upstream sync ... the script, which aborts on a patch of 0 (E-016) and needs GNU grep -P and sed -i (Q-14), is deleted`. The file is still in the tree and in the release Boundary (adoption.md).
Resolution: open, intended: `scripts/update_version` is deleted; FR-039 is removed (owner, 2026-11-25, Q-15)
Recurrence of: -

### E-017 gen_package_json throws a TypeError instead of its missing-dependency error when no layer declares dependencies
Detected: 2026-11-25, adoption extract of release (packages/gen_package_json.ts:45 @9cabe4e4)
Classification: unclassified
Touches: FR-030
Diagnosis: read from the code, not reproduced. The check at lines 44-46 is meant to report a named external that the layers do not declare, with `Dependency does not appear to be installed in root package.json: <name>`. It reads `result.dependencies[key]`. When no layer has a `dependencies` object (core and sample-extension do not layer the root package.json since 109b4058) and an external is named, it reads a property of undefined and throws a TypeError. The named error is never reached. No BUILD file triggers this today: core and sample-extension pass `external_deps = []`.
Resolution: open, intended: the generator fails with its named `Dependency does not appear to be installed in root package.json: <name>` error (owner, 2026-11-25; AC-030.8)
Recurrence of: -

### E-018 The package manifests lack the postgres, postgresql, supabase and mysql keywords
Detected: 2026-11-26, release characterization suite, T-029.1 (packages/@sqlanvil/package.layer.json @9cabe4e4)
Classification: unclassified
Touches: FR-029
Evidence: Run: release characterization suite, 2026-11-26, T-029.1 (tests/prd/release/tarballs.spec.ts), bazel test //tests/prd/... at 9cabe4e4 plus the uncommitted PRD.
  Result: T-029.1 fail: CLI manifest keywords end at "dataops", missing postgres, postgresql, supabase, mysql.
  AC-029.1 (corrected by the owner, Q-19, 2026-11-25) requires keywords ending "dataops", "postgres", "postgresql", "supabase", "mysql" in all three manifests.
  The shared layer packages/@sqlanvil/package.layer.json still holds the upstream eight keywords.
Diagnosis: -
Resolution: -
Recurrence of: -

### E-019 release_github marks an older version's release as Latest
Detected: 2026-11-26, release characterization suite, T-038.9 (scripts/release_github:70 @9cabe4e4)
Classification: unclassified
Touches: FR-038
Evidence: Run: release characterization suite, 2026-11-26, T-038.9 (tests/prd/release/release_github.spec.ts), at 9cabe4e4.
  Result: T-038.9 fail: with VERSION=9.8.6 and version.bzl at 9.8.7, the stub gh recorded `release create v9.8.6 ... --latest` (11 arguments); AC-038.9 expects no --latest.
  scripts/release_github lines 70 and 72 pass --latest on every edit and create, whatever VERSION is.
  AC-038.9 (owner, Q-16, 2026-11-25): a release for a version other than SQLANVIL_VERSION leaves GitHub's Latest unchanged.
Diagnosis: -
Resolution: -
Recurrence of: -

### E-020 regenerate_docs resolves the default COM_REPO against the working directory, not the repository root
Detected: 2026-11-26, release characterization suite, T-040.4 (scripts/regenerate_docs:18 @9cabe4e4)
Classification: code bug
Confirmed: 2026-11-26, "Yes"
Touches: FR-040
Evidence: Run: release characterization suite, 2026-11-26, T-040.4 (tests/prd/release/regenerate_docs.spec.ts), at 9cabe4e4.
  Result: T-040.4 fail: run from T/other with COM_REPO unset, the script found the site at T/other/sqlanvil-com (relative to the working directory) and went on to fail with "bazel-bin/protos/ts.d.ts missing"; AC-040.4 expects the site looked up at ../sqlanvil-com relative to the repository root.
  scripts/regenerate_docs line 18: COM_REPO="${COM_REPO:-../sqlanvil-com}" is resolved against the current directory.
  AC-040.4 (owner, Q-17, 2026-11-25).
Explanation: I ran the release suite's test for this case on the current code. It runs the docs-regeneration script from a folder outside the repository, with no site location given, and with a decoy sqlanvil-com folder placed next to that working folder instead of next to the repository. The script found the decoy, accepted it as the site, and went on to complain about missing Bazel outputs. The PRD says that with no site location given, the script looks for sqlanvil-com next to the repository, whatever folder it is run from, so here it should have stopped with its "site not found, clone the site repo" error. The PRD states the intended behaviour (you set it when answering Q-17) and the code does something else, so this is a code bug rather than a wrong or missing requirement.
Diagnosis: Root cause: `scripts/regenerate_docs` line 18, `COM_REPO="${COM_REPO:-../sqlanvil-com}"`, is a relative default resolved against the current directory; line 17 already computes `REPO_ROOT` but the default does not use it. AC-040.4: "When `COM_REPO` is unset, regenerate_docs shall look for the site at `../sqlanvil-com` relative to the repository root, whatever directory it is run from." Run (HEAD e522aa76, twice; the second with `--nocache_test_results`): `scripts/bazel-ci test //tests/prd/release:regenerate_docs.spec --test_tag_filters=integration --build_tests_only --test_output=all`. T-040.4 expects exit 1 and stdout containing `src/content/docs/docs/reference not found. Clone the site repo`; run from `T/other/sub` with `T/other/sqlanvil-com/src/content/docs/docs/reference` present and no `T/sqlanvil-com`, the script printed `bazel-bin/protos/ts.d.ts missing — run: bazel build //protos:ts //core:version` instead, and the strict expected failure reported `KNOWN-FAILING E-020: known failure E-020: with COM_REPO unset, regenerate_docs looks for the site at ../sqlanvil-com relative to the working directory`.
Resolution: T-040.4 [integration], PRD 2.3.0, fixed in b6bf0230979184b6f1de0ecc1e27e76751ad6f16
Recurrence of: -
