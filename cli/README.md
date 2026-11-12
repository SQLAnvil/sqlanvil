# SQLAnvil CLI Reference

<!-- Mirror of sqlanvil-com src/content/docs/docs/reference/cli.md (published at
     https://sqlanvil.com/docs/reference/cli/). The body below this comment is identical in both
     files (only the header differs). The command table, usage lines and argument/flag tables
     are generated from the CLI definitions in cli/: don't edit the generated blocks by hand.
     Change the definitions (e.g. a flag's `describe`), then run `bazel run //cli:update_readme`,
     which also copies this body to the sqlanvil-com mirror. -->

This page documents every command and flag of the `sqlanvil` CLI. The CLI's own help is the
authority for the version you have installed: `sqlanvil help` lists the commands and
`sqlanvil help <command>` lists that command's flags.

## Installation

```bash
npm install -g @sqlanvil/cli
sqlanvil --version    # sqlanvil 1.38.0 (Dataform core 3.1.5)
```

Requires Node.js 20.19+ or 22.12+. `--version` reports the sqlanvil release and the Dataform core
release it is synced with.

## Invocation

```bash
sqlanvil <command> [positional arguments] [flags]
```

- **`project-dir`** is the first positional argument of most commands and defaults to the current
  directory. Commands that read the project (`compile`, `run`, `test`, `validate`, `format`,
  `install`, `init-creds`, `migrate-fix`) fail unless the directory contains a
  `workflow_settings.yaml`. The one exception is `run --graph`, where the compiled graph is the
  project.
- **Help**: `sqlanvil help run` and `sqlanvil run --help` are the same thing. Running `sqlanvil`
  with no command prints the command list.

## Global behavior

- **Unknown flags are errors.** The CLI is strict: a misspelled flag fails with
  `Unknown arguments: …` rather than being silently ignored, and a misspelled command gets a
  "did you mean" suggestion.
- **List flags** (`--actions`, `--tags`) take space- or comma-separated values:
  `--actions a b` and `--actions a,b` are equivalent.
- **Durations** (`--timeout`, `--execution-timeout`) accept values such as `30s`, `10m`, `2h`.
- **Boolean flags** can be negated with a `--no-` prefix: `--no-artifacts`,
  `--no-test-connection`.
- **Exit codes**: `0` on success, `1` on any failure — compilation errors, a failed or timed-out
  action, a failed unit test, a `validate` FAILURE or BLOCKED result, or `format --check` finding
  unformatted files. This makes every command usable as a CI gate.
- **Ctrl-C** during `run` cancels in-flight actions; during `validate` it drops the temporary shadow
  schemas before exiting.
- **Artifacts**: `compile` writes a queryable catalog, and `run` adds a run-history entry, as Parquet
  under `target/` in the project directory. They are best-effort (a write failure never fails the
  command) and read by `query`, `inspect` and `docs`. Add `target/` to your `.gitignore`. See
  [Artifacts & Catalog](https://sqlanvil.com/docs/guides/artifacts/).

## Commands

<!-- BEGIN GENERATED: commands -->
| Command | Purpose |
|---|---|
| [`init`](#init) | Create a new sqlanvil project (BigQuery, Postgres, Supabase, or MySQL/MariaDB). Use --interactive for a guided setup, including converting a Dataform project. |
| [`install`](#install) | Install a project's NPM dependencies. |
| [`init-creds`](#init-creds) | BigQuery only. Create a .df-credentials.json file interactively. |
| [`compile`](#compile) | Compile the project and print a summary of the graph (the full compiled graph with --json). Never connects to a warehouse. |
| [`test`](#test) | Run the sqlanvil project's unit tests. |
| [`validate`](#validate) | Check every model's SQL against the warehouse planner without running it: EXPLAIN on Postgres, Supabase and MySQL, a dry run on BigQuery. |
| [`run`](#run) | Compile the project and run it against the warehouse named by warehouse: in workflow_settings.yaml. |
| [`query`](#query) | Run SQL over the project's artifacts in target/ (views: actions, dependencies, columns, runs) with the bundled DuckDB. No warehouse is involved. |
| [`inspect`](#inspect) | Summarize the artifacts: action counts by type, and the latest run's status, timing and failures. |
| [`docs`](#docs) | Generate a self-contained HTML catalog of the project at target/docs/index.html, from the artifacts. |
| [`format`](#format) | Format the project's .sqlx and .js files in place. |
| [`introspect`](#introspect) | Read a source table's schema from a connection and write a declaration .sqlx with columnTypes. |
| [`migrate-dataform`](#migrate-dataform) | Convert a Dataform project to sqlanvil. The source directory is never modified; the converted project and its migration report are written to out-dir, which must be empty. |
| [`migrate-fix`](#migrate-fix) | Finish a converted project's dialect rewrites once its declarations have been introspected: the third phase of a migration (convert, introspect, fix). |
| `help [command]` | Show help for every command, or for one command. |
<!-- END GENERATED: commands -->

### `init`

<!-- BEGIN GENERATED: usage init -->
```bash
sqlanvil init [project-dir] [default-database] [default-location]
```
<!-- END GENERATED: usage init -->

Creates a new project: `workflow_settings.yaml`, `package.json`, a `.gitignore` that excludes
`.df-credentials*.json` and `node_modules/`, and a sample project. For Postgres, Supabase and
MySQL/MariaDB it also writes a starter `.df-credentials.json` for you to fill in.

**Positional arguments**

<!-- BEGIN GENERATED: positionals init -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
| `default-database` | No | BigQuery: the Google Cloud project ID models build in. Required for BigQuery; ignored for the other warehouses. |
| `default-location` | No | BigQuery only, optional, e.g. US or europe-west2. If omitted, defaultLocation is not written to workflow_settings.yaml and the credentials file's location is used; if that is also unset, BigQuery infers each job's location from the tables it reads, and new datasets are created in US. |
<!-- END GENERATED: positionals init -->

**Options**

<!-- BEGIN GENERATED: options init -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--warehouse` | string | `supabase` | Target warehouse for the new project: bigquery, postgres, supabase or mysql. |
| `--iceberg` | boolean | `false` | BigQuery only. Prompts for a workflow-level BigQuery Iceberg table configuration. |
| `--bare` | boolean | `false` | Skip the sample files; create empty (gitkept) directories only. |
| `--interactive` | boolean | `false` | Guided Q&amp;A setup: start a fresh project (warehouse, sample project, credentials) or convert an existing Dataform project. Other init arguments are ignored except project-dir, which seeds the directory prompt. |
<!-- END GENERATED: options init -->

On BigQuery, `default-database` (the Google Cloud project ID) is **required** and
`default-location` is optional. The other warehouses ignore both. Without a location, BigQuery
infers each job's location from the tables the job reads. Dataset creation can't be inferred that
way, so new datasets are created in `US`, and scripts that use `SET @@dataset_id` with unqualified
table names may run in `US` too (`run` warns about these). Set a location if your data lives
anywhere else.

### `install`

<!-- BEGIN GENERATED: usage install -->
```bash
sqlanvil install [project-dir]
```
<!-- END GENERATED: usage install -->

Installs the NPM dependencies declared in the project's `package.json` (for example
[packages](https://sqlanvil.com/docs/guides/packages/)). No flags. If compilation fails with
`Could not find NPM dependencies`, run this first.

**Positional arguments**

<!-- BEGIN GENERATED: positionals install -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals install -->

**Options**

<!-- BEGIN GENERATED: options install -->
None.
<!-- END GENERATED: options install -->

### `init-creds`

<!-- BEGIN GENERATED: usage init-creds -->
```bash
sqlanvil init-creds [project-dir]
```
<!-- END GENERATED: usage init-creds -->

**BigQuery only.** Asks for the dataset location (`US`, `EU`, another region, or `auto`, which
leaves `location` out of the file; see [`init`](#init) for what an unset location means), whether
to use Application Default Credentials or a service-account JSON key, and (optional, press Enter to skip) a service account
to impersonate — saved as `impersonateServiceAccount`, see [Credentials file](#credentials-file) —
then writes `.df-credentials.json`. The connection test runs as the impersonated account, so a
missing `roles/iam.serviceAccountTokenCreator` grant surfaces before the file is written. For
Postgres, Supabase and MySQL, edit the template `init` wrote instead.

**Positional arguments**

<!-- BEGIN GENERATED: positionals init-creds -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals init-creds -->

**Options**

<!-- BEGIN GENERATED: options init-creds -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--test-connection` | boolean | `true` | Run SELECT 1 with the new credentials before writing them. --no-test-connection skips it. |
<!-- END GENERATED: options init-creds -->

### `compile`

<!-- BEGIN GENERATED: usage compile -->
```bash
sqlanvil compile [project-dir]
```
<!-- END GENERATED: usage compile -->

Compiles the project and prints a summary of the resulting graph. It never connects to a
warehouse. Exits `1` if the project has compilation errors. With `--json` it prints the full
compiled graph, which is the file `run --graph` accepts. The selection flags filter only the
printed graph. See [Selecting actions](#selecting-actions).

**Positional arguments**

<!-- BEGIN GENERATED: positionals compile -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals compile -->

**Options**

<!-- BEGIN GENERATED: options compile -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--watch` | boolean | `false` | Recompile whenever a file in the project changes (ignores node_modules). |
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
| `--dot` | boolean | `false` | Print the dependency graph in Graphviz dot format. Mutually exclusive with --json. |
| `--timeout` | string | — | Maximum compilation time, e.g. '30s' or '10m'. |
| `--quiet` | boolean | `false` | Less verbose output. Mutually exclusive with --verbose. |
| `--actions` | array | — | Show only these actions in the printed graph (space- or comma-separated names or patterns, \* wildcards allowed). The whole project is still compiled, so ref()s resolve. |
| `--tags` | array | — | Show only actions carrying any of these tags in the printed graph. |
| `--include-deps` | boolean | — | Also show everything the selected actions depend on, transitively. |
| `--include-dependents` | boolean | — | Also show everything downstream of the selected actions, transitively. |
| `--artifacts` | boolean | `true` | Write the queryable Parquet artifacts under target/ (the catalog on compile, run history on run). --no-artifacts skips them. |
| `--verbose` | boolean | `false` | More verbose output. |
| Project-config overrides | — | — | See [Project-config flags](#project-config-flags). |
<!-- END GENERATED: options compile -->

### `test`

<!-- BEGIN GENERATED: usage test -->
```bash
sqlanvil test [project-dir]
```
<!-- END GENERATED: usage test -->

Compiles the project and runs its [unit tests](https://sqlanvil.com/docs/reference/test/) (actions
of `type: "test"`) against the warehouse. Exits `1` if any test fails, or if the project has no
unit tests.

**Positional arguments**

<!-- BEGIN GENERATED: positionals test -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals test -->

**Options**

<!-- BEGIN GENERATED: options test -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--credentials` | string | `.df-credentials.json` | Path to the credentials file, relative to the project directory. An explicit --credentials beats the environment's credentials:, which beats the default. |
| `--timeout` | string | — | Maximum compilation time, e.g. '30s' or '10m'. |
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
| Project-config overrides | — | — | See [Project-config flags](#project-config-flags). |
<!-- END GENERATED: options test -->

### `validate`

<!-- BEGIN GENERATED: usage validate -->
```bash
sqlanvil validate [project-dir]
```
<!-- END GENERATED: usage validate -->

Checks every model's SQL against the warehouse's own planner without running it. On Postgres,
Supabase and MySQL that means `EXPLAIN`; on BigQuery it means a dry run. `validate` compiles into a
temporary, timestamped shadow schema and walks the graph in dependency order. After each model
passes, it creates an empty stub of that model so downstream `ref()`s resolve. The shadow schemas
are dropped at the end, and orphans left by interrupted runs are swept on the next run.

Each action reports one of:

- `PASS`: the planner accepted the SQL.
- `FAIL`: the planner rejected it. The error and its line and column are printed.
- `BLOCK`: the action depends on something that failed.
- `SKIP`: not validated (operations, imports).

Exits `1` on any `FAIL` or `BLOCK`. See the [Validate guide](https://sqlanvil.com/docs/guides/validate/).

**Positional arguments**

<!-- BEGIN GENERATED: positionals validate -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals validate -->

**Options**

<!-- BEGIN GENERATED: options validate -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--actions` | array | — | Action names or patterns to select, space- or comma-separated. A bare name matches the unqualified name (and errors if it's ambiguous), a qualified schema.name matches exactly, and \* wildcards are allowed. |
| `--tags` | array | — | Select every action carrying any of these tags, space- or comma-separated. Combines with --actions as a union. |
| `--include-deps` | boolean | — | Also select everything the selected actions depend on, transitively. Requires --actions or --tags. |
| `--include-dependents` | boolean | — | Also select everything downstream of the selected actions, transitively. Requires --actions or --tags. |
| `--credentials` | string | `.df-credentials.json` | Path to the credentials file, relative to the project directory. An explicit --credentials beats the environment's credentials:, which beats the default. |
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
| `--timeout` | string | — | Maximum compilation time, e.g. '30s' or '10m'. |
| `--keep-shadow` | boolean | — | Leave the temporary shadow schemas in place instead of dropping them, for debugging. |
| Project-config overrides | — | — | See [Project-config flags](#project-config-flags). |
<!-- END GENERATED: options validate -->

### `run`

<!-- BEGIN GENERATED: usage run -->
```bash
sqlanvil run [project-dir]
```
<!-- END GENERATED: usage run -->

Compiles the project and executes it against the warehouse named by `warehouse:` in
`workflow_settings.yaml`. Exits `0` only if every action succeeded. See
[Selecting actions](#selecting-actions) for running part of the graph.

Output modes:

- `--json` prints the run's result (a `RunResult`: overall status, and each action's status,
  tasks, timing and BigQuery job IDs) as one JSON document on stdout, for real runs and BigQuery
  dry runs alike. Progress, warnings and failed unit-test details go to stderr. On Postgres,
  Supabase and MySQL, `--dry-run --json` prints [`validate`](#validate)'s JSON results instead.
- `--build-only` stops after building the execution graph and prints what would run, without
  running anything, then exits `0`. For each dataset it shows its type and its current state in
  the warehouse: `(does not exist)`, a type change such as `(type: table -> view)`, and the last
  modified time where the warehouse reports one (BigQuery). With `--json` it prints the graph
  itself (the SQL of every task, the project and run config, and the warehouse state).
  `--dry-run` and `--run-tests` are ignored with it.

Before 1.38.0, `--json` required `--dry-run` and printed the execution graph. Scripts that used
`run --dry-run --json` to get the graph should switch to `run --build-only --json`.

**Positional arguments**

<!-- BEGIN GENERATED: positionals run -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals run -->

**Options**

<!-- BEGIN GENERATED: options run -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--dry-run` | boolean | — | Check the run without applying changes. On BigQuery this is BigQuery's server-side dry run; on Postgres, Supabase and MySQL it runs validate, because those warehouses have no native dry run. |
| `--build-only` | boolean | `false` | Only builds the execution graph (what would run, and each dataset's current state in the warehouse) without running anything. With --json, prints the graph as JSON. --dry-run and --run-tests are ignored when this is set. |
| `--run-tests` | boolean | — | Run the project's unit tests first, and abort the run if any fail. |
| `--action-retry-limit` | number | `0` | Retry failed idempotent actions up to this many times. |
| `--actions` | array | — | Action names or patterns to select, space- or comma-separated. A bare name matches the unqualified name (and errors if it's ambiguous), a qualified schema.name matches exactly, and \* wildcards are allowed. |
| `--credentials` | string | `.df-credentials.json` | Path to the credentials file, relative to the project directory. An explicit --credentials beats the environment's credentials:, which beats the default. |
| `--full-refresh` | boolean | `false` | Rebuild incremental tables from scratch. |
| `--graph` | string | — | Run a stored compiled graph (the output of compile --json) instead of compiling. What runs is exactly what was compiled, including any environment overrides baked in at compile time. |
| `--include-deps` | boolean | — | Also select everything the selected actions depend on, transitively. Requires --actions or --tags. |
| `--include-dependents` | boolean | — | Also select everything downstream of the selected actions, transitively. Requires --actions or --tags. |
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
| `--timeout` | string | — | Maximum compilation time, e.g. '30s' or '10m'. |
| `--execution-timeout` | string | — | Wall-clock deadline for the entire run (compilation plus every action), e.g. '15m'. When it expires, in-flight actions are cancelled, pending ones are skipped and the run fails. Off by default. |
| `--tags` | array | — | Select every action carrying any of these tags, space- or comma-separated. Combines with --actions as a union. |
| `--job-prefix` | string | — | BigQuery only. Prefix for BigQuery job IDs: --job-prefix nightly gives sqlanvil-nightly-&lt;uuid&gt;. |
| `--job-labels` | string | — | BigQuery only. Labels added to every BigQuery job, e.g. team=data,pipeline=nightly. |
| `--artifacts` | boolean | `true` | Write the queryable Parquet artifacts under target/ (the catalog on compile, run history on run). --no-artifacts skips them. |
| Project-config overrides | — | — | See [Project-config flags](#project-config-flags). |
<!-- END GENERATED: options run -->

Restrictions on `--graph`:

- It can't be combined with `--environment`, because environment overrides are applied at compile
  time. Compile with `--environment`, then pass `--credentials` to the run.
- It can't be combined with `--dry-run` on Postgres, Supabase or MySQL, because validation
  recompiles from source. Run `validate` on the project instead.
- If the graph was compiled by a different minor version of sqlanvil, `run` warns but still runs.

### `query`

<!-- BEGIN GENERATED: usage query -->
```bash
sqlanvil query [sql] [project-dir]
```
<!-- END GENERATED: usage query -->

Runs SQL over the project's artifacts with the bundled DuckDB. No warehouse is involved. The
available views are `actions`, `dependencies` and `columns` (written by `compile`) and `runs`
(written by `run`). Run `compile` first.

**Positional arguments**

<!-- BEGIN GENERATED: positionals query -->
| Argument | Required | Description |
|---|---|---|
| `sql` | No | SQL to run, e.g. "select type, count(\*) from actions group by 1". |
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals query -->

**Options**

<!-- BEGIN GENERATED: options query -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
<!-- END GENERATED: options query -->

### `inspect`

<!-- BEGIN GENERATED: usage inspect -->
```bash
sqlanvil inspect [project-dir]
```
<!-- END GENERATED: usage inspect -->

Summarizes the artifacts: action counts by type, plus the latest run's status, success and
failure counts, wall time, and up to 20 failures with their error messages.

**Positional arguments**

<!-- BEGIN GENERATED: positionals inspect -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals inspect -->

**Options**

<!-- BEGIN GENERATED: options inspect -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | boolean | `false` | Outputs the result as JSON instead of human-readable text. |
<!-- END GENERATED: options inspect -->

### `docs`

<!-- BEGIN GENERATED: usage docs -->
```bash
sqlanvil docs [project-dir]
```
<!-- END GENERATED: usage docs -->

Writes a self-contained HTML catalog of the project to `target/docs/index.html`, covering models,
types, tags, columns, dependencies and last-run status. It is built from the artifacts, so run
`compile` (or `run`) first. No flags.

**Positional arguments**

<!-- BEGIN GENERATED: positionals docs -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals docs -->

**Options**

<!-- BEGIN GENERATED: options docs -->
None.
<!-- END GENERATED: options docs -->

### `format`

<!-- BEGIN GENERATED: usage format -->
```bash
sqlanvil format [project-dir]
```
<!-- END GENERATED: usage format -->

Formats the project's files in place. By default that is every `.sqlx` and `.js` file under
`definitions/` and `includes/`. For `format`, `--actions` takes **file globs** relative to the
project directory, not action names.

**Positional arguments**

<!-- BEGIN GENERATED: positionals format -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals format -->

**Options**

<!-- BEGIN GENERATED: options format -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--actions` | array | `{definitions,includes}/**/*.{js,sqlx}` | File globs to format, relative to the project directory (not action names). |
| `--check` | boolean | `false` | Change nothing; exit 1 if any file would be reformatted. |
| `--ignore-js-files` | boolean | `false` | Skip .js files (with the default globs, only .sqlx files are formatted). |
<!-- END GENERATED: options format -->

### `introspect`

<!-- BEGIN GENERATED: usage introspect -->
```bash
sqlanvil introspect <connection> <tableRef> [project-dir]
```
<!-- END GENERATED: usage introspect -->

Reads a source table's schema through one of the named `connections:` in `workflow_settings.yaml`
and generates a declaration `.sqlx` with its `columnTypes`. Source types are mapped to the
warehouse's types. `tableRef` is `schema.table`, or just `table`. The source's credentials come
from the `connections` section of `.df-credentials.json`. See
[Foreign Data Wrappers](https://sqlanvil.com/docs/guides/foreign-wrappers/).

**Positional arguments**

<!-- BEGIN GENERATED: positionals introspect -->
| Argument | Required | Description |
|---|---|---|
| `connection` | **Yes** | Connection name (from workflow_settings.yaml connections). |
| `tableRef` | **Yes** | Source table as schema.table (or just table). |
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals introspect -->

**Options**

<!-- BEGIN GENERATED: options introspect -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--output` | string | — | File to write the declaration .sqlx to. Prints to stdout if omitted. |
<!-- END GENERATED: options introspect -->

### `migrate-dataform`

<!-- BEGIN GENERATED: usage migrate-dataform -->
```bash
sqlanvil migrate-dataform <source-dir> <out-dir>
```
<!-- END GENERATED: usage migrate-dataform -->

Converts a Dataform project to sqlanvil. The source directory is never modified. The converted
project, plus `migration-report.md` and `migration-report.json`, are written to `out-dir`, which
must be empty. See [Migrate from Dataform](https://sqlanvil.com/docs/guides/migrate-dataform/).

**Positional arguments**

<!-- BEGIN GENERATED: positionals migrate-dataform -->
| Argument | Required | Description |
|---|---|---|
| `source-dir` | **Yes** | The Dataform project to convert (never modified). |
| `out-dir` | **Yes** | Where the converted sqlanvil project is written (created; must be empty). |
<!-- END GENERATED: positionals migrate-dataform -->

**Options**

<!-- BEGIN GENERATED: options migrate-dataform -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--target-warehouse` | string | `supabase` | Where the converted project runs. supabase or postgres moves the warehouse: BigQuery sources become named connections and the SQL gets safe dialect rewrites plus inline SQLANVIL-MIGRATE markers. bigquery is a tooling swap: the project keeps running on BigQuery with its SQL and bigquery: {} blocks untouched. |
<!-- END GENERATED: options migrate-dataform -->

### `migrate-fix`

<!-- BEGIN GENERATED: usage migrate-fix -->
```bash
sqlanvil migrate-fix [project-dir]
```
<!-- END GENERATED: usage migrate-fix -->

The third phase of a migration (convert, introspect, fix). Run it after the converted project's
declarations have been introspected (`sh scripts/introspect_all.sh`, generated by
`migrate-dataform`). It expands
`SELECT * EXCEPT (...)` into explicit column lists and rewrites `GROUP BY ALL` as positional
ordinals; both need the source columns that introspection provides. It is safe to re-run. It
reports anything it couldn't resolve, rather than guessing, and exits `1` if anything is
unresolved.

**Positional arguments**

<!-- BEGIN GENERATED: positionals migrate-fix -->
| Argument | Required | Description |
|---|---|---|
| `project-dir` | No (default `.`) | The sqlanvil project directory. |
<!-- END GENERATED: positionals migrate-fix -->

**Options**

<!-- BEGIN GENERATED: options migrate-fix -->
| Flag | Type | Default | Description |
|---|---|---|---|
| `--dry-run` | boolean | `false` | Report what would change without writing. |
<!-- END GENERATED: options migrate-fix -->

## Selecting actions

`run`, `validate` and `compile` share four selection flags:

| Flag | Description |
|---|---|
| `--actions` | Action names or patterns. A bare name (`orders`) matches by unqualified name and errors if it's ambiguous; a qualified name (`analytics.orders`) matches exactly. `*` wildcards are allowed: `stg_*` matches unqualified names, and `analytics.*` matches qualified ones. |
| `--tags` | Select every action carrying any of these tags. Combines with `--actions` as a union. |
| `--include-deps` | Also select everything the selected actions depend on, transitively. Requires `--actions` or `--tags`. |
| `--include-dependents` | Also select everything downstream of the selected actions, transitively. Requires `--actions` or `--tags`. |

Without `--include-deps`, only the selected actions run, so their upstream tables must already
exist.

## Project-config flags

`compile`, `run`, `test` and `validate` accept these flags. Each one overrides a setting in
`workflow_settings.yaml` for a single invocation. When a flag is unset, the file's value applies.

<!-- BEGIN GENERATED: project-config-options -->
| Flag | Type | Overrides | Description |
|---|---|---|---|
| `--default-database` | string | `defaultProject` | Default database. On BigQuery, the Google Cloud project ID. |
| `--default-schema` | string | `defaultDataset` | Default schema (a dataset on BigQuery). |
| `--default-location` | string | `defaultLocation` | BigQuery only. Default location, e.g. US. run and validate send BigQuery jobs and create new datasets in this location, even when the credentials file names a different location (run warns about the mismatch). See https://cloud.google.com/bigquery/docs/locations for supported values. |
| `--assertion-schema` | string | `defaultAssertionDataset` | Schema that assertions are written to. |
| `--vars` | string | `vars` | Variables as comma-separated key=value pairs, e.g. --vars=env=staging,region=eu, read in code as sqlanvil.projectConfig.vars.&lt;key&gt;. Values can't contain , or =. Keys merge with the file's vars, so a --vars key overrides only that key. |
| `--database-suffix` | string | `projectSuffix` | Suffix appended to database names. |
| `--schema-suffix` | string | `datasetSuffix` | Suffix appended to schema names, e.g. dev gives analytics_dev. Letters, digits and underscores only. |
| `--table-prefix` | string | `namePrefix` | Prefix added to every table name. |
| `--disable-assertions` | boolean | `disableAssertions` | Skip every assertion, built-in (uniqueKey, nonNull, rowConditions) and type: "assertion". |
| `--default-reservation` | string | `defaultReservation` | BigQuery only. Reservation to run queries in. If neither this nor the file sets one, default BigQuery behavior applies. |
| `--environment` | string | — | Load a named environment from environments: in workflow_settings.yaml. That environment's schemaSuffix, vars, defaultDatabase, defaultLocation and credentials file apply, and explicit flags override them. See https://sqlanvil.com/docs/guides/environments/ |
<!-- END GENERATED: project-config-options -->

Precedence is **flags > `--environment` > `workflow_settings.yaml`**. `vars` merge key by key, so a
`--vars` key overrides that key and keeps the others.

## Other shared flags

| Flag | Commands | Description |
|---|---|---|
| `--credentials` | `run`, `test`, `validate` | Path to the credentials file, relative to the project directory. Defaults to `.df-credentials.json`. An explicit `--credentials` beats the environment's `credentials:`, which beats the default. |
| `--json` | `compile`, `run`, `test`, `validate`, `query`, `inspect` | Machine-readable output. |
| `--timeout` | `compile`, `run`, `test`, `validate` | Maximum compilation time. Use `--execution-timeout` on `run` to bound the whole run. |
| `--no-artifacts` | `compile`, `run` | Don't write Parquet artifacts under `target/`. |

## Credentials file

Warehouse connections, including secrets, live in `.df-credentials.json` in the project directory.
It is gitignored by `init` and must never be committed. Non-secret settings stay in
`workflow_settings.yaml`. The file's shape depends on `warehouse:`.

**Postgres / Supabase**: for Supabase, use the session pooler host, because the direct
`db.<ref>.supabase.co` host is IPv6-only.

```json
{
  "host": "aws-1-us-east-1.pooler.supabase.com",
  "port": 5432,
  "database": "postgres",
  "user": "postgres.your-project-ref",
  "password": "…",
  "sslMode": "require",
  "defaultSchema": "public"
}
```

`sslMode` is one of `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`.

**MySQL / MariaDB**:

```json
{
  "host": "localhost",
  "port": 3306,
  "database": "sqlanvil",
  "user": "root",
  "password": "…",
  "sslMode": "disable"
}
```

`sslMode` is `disable` or `require`.

**BigQuery** (written by `init-creds`):

```json
{
  "projectId": "my-gcp-project",
  "location": "US",
  "credentials": "{\"type\": \"service_account\", …}"
}
```

`location` is optional: without it (and without `defaultLocation` in `workflow_settings.yaml`),
BigQuery infers each job's location, as described under [`init`](#init). `credentials` is the
service-account key JSON as a string. Omit it to use Application Default
Credentials (`gcloud auth application-default login`). `accessToken` takes a short-lived OAuth2
token instead, and wins over `credentials`. `impersonateServiceAccount` (a service-account email)
makes the CLI run BigQuery queries as that account without holding its key: your ADC identity, or
the `credentials` key, is the source and needs `roles/iam.serviceAccountTokenCreator` on it.
Precedence: `accessToken` → `impersonateServiceAccount` → `credentials` → ADC. The same fields work
in a `connections.<name>` BigQuery entry.

Two optional sections can sit alongside the warehouse fields:

- **`connections`** holds credentials for named source connections, keyed by connection name. They
  are used by `introspect` and by `run` for cross-warehouse sources. See
  [Foreign Data Wrappers](https://sqlanvil.com/docs/guides/foreign-wrappers/).
- **`storage`** holds object-store credentials (`s3`, `gcs`) for file exports and imports on
  Postgres/Supabase. See [File Exports](https://sqlanvil.com/docs/guides/exports/).

To keep one file per environment, name them `.df-credentials.<env>.json` (also gitignored) and
point each environment's `credentials:` at its file.

## Examples

### First-time project setup

```bash
# Supabase (the default warehouse) — then fill in .df-credentials.json
sqlanvil init my_project
cd my_project && sqlanvil install

# Postgres or MySQL/MariaDB
sqlanvil init my_project --warehouse postgres

# BigQuery — the project ID is required; the location (here US) is optional
sqlanvil init my_project my-gcp-project US --warehouse bigquery
sqlanvil init-creds my_project

# Not sure? Answer a few questions instead
sqlanvil init --interactive
```

### Compiling and inspecting a project without touching the warehouse

```bash
# Human-readable summary
sqlanvil compile

# Full compiled graph as JSON, e.g. to pipe into jq
sqlanvil compile --json | jq '.tables[].target'

# Visualize the dependency graph
sqlanvil compile --dot | dot -Tsvg > graph.svg

# Show only part of the graph (the whole project still compiles)
sqlanvil compile --actions orders --include-deps

# Ask questions of the compiled catalog
sqlanvil query "select type, count(*) from actions group by 1"
sqlanvil docs && open target/docs/index.html
```

### Validating before running

```bash
# Check every model against the planner; nothing is executed
sqlanvil validate

# Just one model and everything it reads from
sqlanvil validate --actions orders --include-deps

# `run --dry-run` does the same on Postgres/Supabase/MySQL (a BigQuery dry run on BigQuery)
sqlanvil run --dry-run
```

### Running unit tests before deploying changes

```bash
sqlanvil test

# ...or fail a run early if tests don't pass
sqlanvil run --run-tests
```

### Running only part of a pipeline

```bash
# Run a specific table (by bare name or full schema.name) and everything downstream of it
sqlanvil run --actions orders --include-dependents

# Run everything tagged "daily", including their dependencies
sqlanvil run --tags daily --include-deps

# Rebuild the "events" incremental table from scratch
sqlanvil run --actions events --full-refresh
```

### Bounding how long a run is allowed to take

```bash
# Compilation must finish within 30s; the whole run (compile + execute) within 15 minutes
sqlanvil run --timeout 30s --execution-timeout 15m
```

### Targeting a different environment for one invocation

```bash
# Uses environments.dev from workflow_settings.yaml: its schema suffix, vars and credentials file
sqlanvil run --environment dev

# Or override individual settings directly
sqlanvil run --schema-suffix pr_123 --vars=region=eu
```

### Compile once, run later

Compile a pinned graph, review or store it, then run exactly that graph:

```bash
sqlanvil compile --environment prod --json > graph.json
sqlanvil run --graph graph.json --credentials .df-credentials.prod.json
```

### Iterating on SQLX during development

```bash
sqlanvil compile --watch
```

### Checking formatting without modifying files

```bash
sqlanvil format --check    # exits 1 if anything would change — use as a CI step
```

### Inspecting the last run

```bash
sqlanvil inspect
sqlanvil query "select readable_name, status from runs where run_id = (select max(run_id) from runs)"
```

### Tracking and labeling BigQuery jobs from a run

```bash
# Job IDs become sqlanvil-nightly-<uuid>; every job carries both labels
sqlanvil run --job-prefix nightly --job-labels team=data,pipeline=nightly
```

### Declaring a cross-warehouse source

```bash
# Write a declaration for bigquery_public's samples.shakespeare
sqlanvil introspect bigquery_public samples.shakespeare --output definitions/sources/shakespeare.sqlx
```

### Migrating a Dataform project

```bash
sqlanvil migrate-dataform ./dataform_project ./sqlanvil_project   # 1. convert
(cd sqlanvil_project && sh scripts/introspect_all.sh)             # 2. introspect sources
sqlanvil migrate-fix ./sqlanvil_project                           # 3. finish the dialect work
sqlanvil compile ./sqlanvil_project
```
