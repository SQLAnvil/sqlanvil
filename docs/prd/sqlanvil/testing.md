<!-- Format: references/prd-format.md, "testing.md". -->

# Testing

## Levels

| Level | Harness command | Environment | Gate |
|---|---|---|---|
| unit | `bazel test //... --test_tag_filters=-integration --build_tests_only` | local | build |
| integration | `bazel test //tests/prd/... --test_tag_filters=integration --build_tests_only --test_output=all` | local | build |
| warehouse | `bazel test //tests/integration/... //tests/api/... --test_tag_filters=integration --build_tests_only` | local | build |

## Harness

<!--
The conventions every test relies on. A black-box tester reads only this folder, so each one
must be written here before any test case is. State the convention, not a helper's code: how a
helper is built inside (method signatures, return values, defaults) is the tester's choice and
goes in its HARNESS CHOICES. Answer a slot that does not apply with `Not applicable: <reason>`,
for example Browser identity when there is no UI.
-->

- **Lifecycle.** Bazel builds the code under test and runs each test target. The Postgres and Supabase integration specs start their own Docker container (image `pgvector/pgvector:0.8.7-pg15`), one per spec on its own host port (5432 `postgres.spec`, 5433 `supabase.spec`, 5434 `supabase_rls.spec`); the MySQL fixture starts `mysql:8` on 3306 and MariaDB on 3307. When `PG_*`, `SUPABASE_*` or `MYSQL_HOST` variables are passed with `--test_env`, the fixture uses that database and skips Docker. The BigQuery spec uses a real GCP project through `test_credentials/bigquery.json`. A case that needs `@duckdb/node-api` to fail to load runs its code in a child Node process started with a `--require` preload whose module resolver throws for that package (owner, 2026-11-22). A CLI case runs the bundled CLI with Node, `execFile(nodePath, [cliEntryPointPath, ...argv])` (`cliEntryPointPath` from `sa/cli/index_test_base`, which is `packages/@sqlanvil/cli/bundle.js`), inside `getProcessResult` from `sa/testing`, which gives the exit code, stdout and stderr; its `ts_test_suite` lists `//packages/@sqlanvil/cli:bundle`, `:json` and `:worker_bundle` in `data`, as `cli/BUILD` does (owner, 2026-11-22).
- **Environment switch.** The Bazel tag and the target path decide the level: targets tagged `integration` under `tests/prd/` run in the integration level (the characterization suites), targets tagged `integration` under `tests/integration/` and `tests/api/` in the warehouse level, and everything else in the unit level (owner, 2026-11-22). A database is chosen by the `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` (or `SUPABASE_*`, `MYSQL_HOST`) variables passed with `--test_env`; with none, the fixture's own container on 127.0.0.1 is used.
- **Database access.** A test reads and writes a warehouse through sqlanvil's own adapters (`sa/cli/api/dbadapters`, for example `PostgresDbAdapter.create(...)`) and reads rows back with the helpers in `tests/integration/utils.ts`.
- **Tools on the runner.** Bazelisk, installed so that `bazel` is on PATH (on macOS, `brew install bazelisk` puts both in `/opt/homebrew/bin`), which runs Bazel 7.3.2 from `.bazelversion`, and Docker on PATH; a `~/.npmrc` file, empty if nothing else, because `MODULE.bazel` sets `use_home_npmrc = True` and rules_js fails when the file is missing; Bazel downloads Node.js 24.13.0 and pnpm 9.7.1 itself. Full-tree builds on macOS need `--config=macos-cpp`.
- **Clean state.** Each integration spec drops the test schemas it uses before it runs, so a spec starts from no leftover tables of its own. A characterization case that names `P` makes it a new empty directory with `fs.mkdtemp` under `os.tmpdir()` and removes it after the case (under Bazel `os.tmpdir()` is the system temporary directory, such as `/tmp`, not `TEST_TMPDIR`, so the removal is the test's own job); the artifacts suite creates no warehouse schemas (owner, 2026-11-22). [NEEDS CLARIFICATION: which schemas a characterization suite of a warehouse area may create]
- **Persistent environments.** [NEEDS CLARIFICATION: the BigQuery project behind `test_credentials/bigquery.json` keeps data between runs: how its fixtures get there and what a test must never do there]
- **Layout.** Unit tests sit beside the code they test as `*_test.ts` in `core/`, `cli/`, `sqlx/`, `common/` and `testing/`, run by the unit level's command (those directories mix tests with code, so they are not test roots); warehouse specs are `tests/integration/*.spec.ts` and `tests/api/*.spec.ts`, each a `ts_test_suite` target (from `//testing:index.bzl`) in the directory's `BUILD` file, tagged `integration`, with sample projects as `data`. The characterization suite lives under `tests/prd/`, one directory per area (`tests/prd/artifacts/` for the artifacts area), as `ts_test_suite` targets tagged `integration` (owner, 2026-11-22). A test cites its T-id at the start of its test name, `test("@prd T-001.1 <what it checks>", …)`, so each runner result names its T-id; a known-failing case's name starts `@prd <T-id> known-failing <E-nnn>` (owner, 2026-11-22). `sa/testing` has no expected-failure mode, so a known-failing case is written as a strict expected failure with a helper in the suite's own `tests/prd/` folder: it runs the case body and passes only when the body fails with the case's `symptom:`, and fails when the body passes or fails some other way; `sa/testing` itself is not changed (owner, 2026-11-22). A characterization test calls the code under test through these modules (read from the code at @984785d8, owner, 2026-11-22): `queryParquet(sql: string, views: ArtifactView[])` and `writeParquet(rows: object[], outPath: string, columns: string[])` from `sa/cli/api/dbadapters/duckdb_artifacts`, where an `ArtifactView` is `{name: string, glob: string}` and a case's views are an array of them, one per view the case names (`actions`, `dependencies` and `columns` with globs `<P>/target/catalog/<name>.parquet`, `runs` with glob `<P>/target/runs/*.parquet`); `queryParquet` resolves to the rows as plain objects keyed by column name. `buildDocsModel(views: ArtifactView[], generatedAt: string)` and `renderDocsHtml` from `sa/cli/api/commands/docs`, `writeArtifacts` and `safeWriteArtifacts` from `sa/cli/api/commands/artifacts`, `run` and `evaluate` from `sa/cli/api/commands/query`. A protobufjs Long value is `Long.fromNumber(n)` from the `long` package. The Bazel labels are `//cli/api` (the `sa/cli/api/...` modules), `//cli:index_test_base`, `//protos:ts`, `//testing`, `//:node_modules/@duckdb/node-api` and `//:node_modules/long`. Test roots: `tests/`, `testing/`
- **HTTP requests.** Not applicable: sqlanvil has no HTTP API; BigQuery is reached through its client library inside the adapter.
- **Fixtures.** A sample project is a directory under the test's own folder, exposed to the test by `:files` and `:node_modules` targets in its `BUILD` file and passed as `data`. [NEEDS CLARIFICATION: how a case's `contracts/fixtures/` preconditions are loaded before the test body, and what Load paths are relative to]
- **Browser identity.** Not applicable: sqlanvil has no browser UI.
- **Assertions.** Tests use `suite` and `test` from `sa/testing` and chai's `expect`. Only the fields a case lists are asserted; fields it does not list are ignored. A list compares element by element, in the order the case gives. Generated text (SQL, HTML, CLI output) is matched as the case words it, contains or equals, and is never whitespace-normalised unless the case says so (owner, 2026-11-22).
- **Waits.** A characterization test waits at most the `sa/testing` default of 30 s (owner, 2026-11-22). [NEEDS CLARIFICATION: how long an expectation waits for a container, a table or a warehouse run to finish before it fails]
- **Effects.** [NEEDS CLARIFICATION: which columns an effect on a warehouse table checks, and what "unchanged" compares]
- **Leaks.** [NEEDS CLARIFICATION: which values a leak check scans for in the CLI's stdout and stderr (connection passwords and tokens), how they match, and how a failure report avoids printing the values a test passes in the `sa/testing` runner]
- **Acceptance.** [NEEDS CLARIFICATION: whether sqlanvil has acceptance cases signed by a person, or Not applicable]

## Environments

| Environment | Purpose | Access | Base URL | Database | Logs |
|---|---|---|---|---|---|
| local | building and testing on a developer machine, with Docker containers for the integration databases | [NEEDS CLARIFICATION: who may use it] | none | the fixture's container on 127.0.0.1 (`PG_*`, `SUPABASE_*`, `MYSQL_HOST` to override); BigQuery through `test_credentials/bigquery.json` | the Bazel test logs under `bazel-testlogs/` |
| npm-beta | prerelease builds published under the npm `beta` dist-tag, for testing the stateless core install | [NEEDS CLARIFICATION: who may use it] | none | none | `npm view @sqlanvil/cli dist-tags` |
| npm | released builds under the npm `latest` dist-tag | [NEEDS CLARIFICATION: who may use it] | none | none | `npm view @sqlanvil/cli dist-tags` |

## Leak checks

| Sink | Read from | Scanned for |
|---|---|---|
| CLI output | the stdout and stderr that `getProcessResult` returns for the CLI case (Harness, Lifecycle) | [NEEDS CLARIFICATION: the credential fields that must never appear] |
| error messages | [NEEDS CLARIFICATION: which outputs carry warehouse error text] | [NEEDS CLARIFICATION: the credential fields that must never appear] |

## Fixtures

| Fixture | Creates | Load | Teardown |
|---|---|---|---|
| [NEEDS CLARIFICATION: first fixture name, a path under contracts/fixtures/ without extension] | [NEEDS CLARIFICATION: what it creates] | [NEEDS CLARIFICATION: load command] | [NEEDS CLARIFICATION: teardown command] |

## Sign-offs

| T-id | Owner | Date | Result |
|---|---|---|---|
