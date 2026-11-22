<!-- Format: references/prd-format.md, "testing.md". -->

# Testing

## Levels

| Level | Harness command | Environment | Gate |
|---|---|---|---|
| unit | `bazel test //... --test_tag_filters=-integration --build_tests_only` | local | build |
| integration | `bazel test //... --test_tag_filters=integration --build_tests_only` | local | build |

## Harness

<!--
The conventions every test relies on. A black-box tester reads only this folder, so each one
must be written here before any test case is. State the convention, not a helper's code: how a
helper is built inside (method signatures, return values, defaults) is the tester's choice and
goes in its HARNESS CHOICES. Answer a slot that does not apply with `Not applicable: <reason>`,
for example Browser identity when there is no UI.
-->

- **Lifecycle.** Bazel builds the code under test and runs each test target. The Postgres and Supabase integration specs start their own Docker container (image `pgvector/pgvector:0.8.7-pg15`), one per spec on its own host port (5432 `postgres.spec`, 5433 `supabase.spec`, 5434 `supabase_rls.spec`); the MySQL fixture starts `mysql:8` on 3306 and MariaDB on 3307. When `PG_*`, `SUPABASE_*` or `MYSQL_HOST` variables are passed with `--test_env`, the fixture uses that database and skips Docker. The BigQuery spec uses a real GCP project through `test_credentials/bigquery.json`. A case that needs `@duckdb/node-api` to fail to load runs its code in a child Node process started with a `--require` preload whose module resolver throws for that package (owner, 2026-11-22). A CLI case runs the bundled CLI with Node, `execFile(nodePath, [cliEntryPointPath, ...argv])` (`cliEntryPointPath` from `sa/cli/index_test_base`, which is `packages/@sqlanvil/cli/bundle.js`), inside `getProcessResult` from `sa/testing`, which gives the exit code, stdout and stderr; its `ts_test_suite` lists `//packages/@sqlanvil/cli:bundle`, `:json` and `:worker_bundle` in `data`, as `cli/BUILD` does (owner, 2026-11-22).
- **Environment switch.** The Bazel tag decides the level: targets tagged `integration` run only in the integration level, everything else in the unit level. A database is chosen by the `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` (or `SUPABASE_*`, `MYSQL_HOST`) variables passed with `--test_env`; with none, the fixture's own container on 127.0.0.1 is used.
- **Database access.** A test reads and writes a warehouse through sqlanvil's own adapters (`sa/cli/api/dbadapters`, for example `PostgresDbAdapter.create(...)`) and reads rows back with the helpers in `tests/integration/utils.ts`.
- **Tools on the runner.** Bazelisk (Bazel 7.3.2 from `.bazelversion`) and Docker on PATH; Bazel downloads Node.js 24.13.0 and pnpm 9.7.1 itself. Full-tree builds on macOS need `--config=macos-cpp`.
- **Clean state.** Each integration spec drops the test schemas it uses before it runs, so a spec starts from no leftover tables of its own. [NEEDS CLARIFICATION: whether the characterization suite follows the same rule, and which schemas it may create]
- **Persistent environments.** [NEEDS CLARIFICATION: the BigQuery project behind `test_credentials/bigquery.json` keeps data between runs: how its fixtures get there and what a test must never do there]
- **Layout.** Unit tests sit beside the code they test as `*_test.ts` in `core/`, `cli/`, `sqlx/`, `common/` and `testing/`, run by the unit level's command (those directories mix tests with code, so they are not test roots); integration specs are `tests/integration/*.spec.ts` and `tests/api/*.spec.ts`, each a `ts_test_suite` target (from `//testing:index.bzl`) in the directory's `BUILD` file, tagged `integration`, with sample projects as `data`. [ASSUMPTION A-03: the characterization suite lives under `tests/prd/`, one directory per area, as `ts_test_suite` targets tagged `integration`.] [NEEDS CLARIFICATION: how a test cites its T-id]. Test roots: `tests/`, `testing/`
- **HTTP requests.** Not applicable: sqlanvil has no HTTP API; BigQuery is reached through its client library inside the adapter.
- **Fixtures.** A sample project is a directory under the test's own folder, exposed to the test by `:files` and `:node_modules` targets in its `BUILD` file and passed as `data`. [NEEDS CLARIFICATION: how a case's `contracts/fixtures/` preconditions are loaded before the test body, and what Load paths are relative to]
- **Browser identity.** Not applicable: sqlanvil has no browser UI.
- **Assertions.** Tests use `suite` and `test` from `sa/testing` and chai's `expect`. [NEEDS CLARIFICATION: whether fields a case does not list are asserted, how lists compare (order), and how generated SQL text is compared (exact, or whitespace-normalised)]
- **Waits.** [NEEDS CLARIFICATION: how long an expectation waits for a container, a table or a run to finish before it fails]
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
