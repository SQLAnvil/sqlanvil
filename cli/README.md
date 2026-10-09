# SQLAnvil CLI Reference

<!-- Mirror of sqlanvil-com src/content/docs/docs/reference/cli.md (published at
     https://sqlanvil.com/docs/reference/cli/). The body below this comment is identical in both
     files (only the header differs) — change one, change the other. -->

This page documents every command and flag of the `sqlanvil` CLI. The CLI's own help is the
authority for the version you have installed: `sqlanvil help` lists the commands and
`sqlanvil help <command>` lists that command's flags.

## Installation

```bash
npm install -g @sqlanvil/cli
sqlanvil --version    # sqlanvil 1.32.10 (Dataform core 3.0.71)
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

| Command | Purpose | Needs a warehouse |
|---|---|---|
| [`init`](#init) | Create a new project | no |
| [`install`](#install) | Install the project's NPM dependencies | no |
| [`init-creds`](#init-creds) | Create a BigQuery credentials file interactively | yes (to test) |
| [`compile`](#compile) | Compile the project and print the graph | no |
| [`test`](#test) | Run the project's unit tests | yes |
| [`validate`](#validate) | Check every model's SQL against the warehouse planner without executing | yes |
| [`run`](#run) | Run the project | yes |
| [`query`](#query) | Run SQL over the project's artifacts | no |
| [`inspect`](#inspect) | Summarize the artifacts and the latest run | no |
| [`docs`](#docs) | Generate an HTML catalog of the project | no |
| [`format`](#format) | Format `.sqlx` and `.js` files | no |
| [`introspect`](#introspect) | Generate a declaration from a source table's schema | yes (the source) |
| [`migrate-dataform`](#migrate-dataform) | Convert a Dataform project to sqlanvil | no |
| [`migrate-fix`](#migrate-fix) | Finish a converted project's dialect rewrites | no |
| `help [command]` | Show help | no |

### `init`

```bash
sqlanvil init [project-dir] [default-database] [default-location]
```

Creates a new project: `workflow_settings.yaml`, `package.json`, a `.gitignore` that excludes
`.df-credentials*.json` and `node_modules/`, and a sample project. For Postgres, Supabase and
MySQL/MariaDB it also writes a starter `.df-credentials.json` for you to fill in.

| Flag | Default | Description |
|---|---|---|
| `--warehouse` | `supabase` | Target warehouse: `bigquery`, `postgres`, `supabase` or `mysql`. |
| `--interactive` | `false` | Guided setup: start a fresh project (warehouse, sample, credentials) or convert an existing Dataform project. Ignores the other arguments except `project-dir`, which seeds the directory prompt. |
| `--bare` | `false` | Skip the sample files; create empty (gitkept) directories only. |
| `--iceberg` | `false` | BigQuery only. Prompts for a workflow-level BigQuery Iceberg table configuration. |

`default-database` (the Google Cloud project ID) and `default-location` (for example `US` or
`europe-west2`) are **required for BigQuery** and ignored for the other warehouses.

### `install`

```bash
sqlanvil install [project-dir]
```

Installs the NPM dependencies declared in the project's `package.json` (for example
[packages](https://sqlanvil.com/docs/guides/packages/)). No flags. If compilation fails with
`Could not find NPM dependencies`, run this first.

### `init-creds`

```bash
sqlanvil init-creds [project-dir]
```

**BigQuery only.** Asks for the dataset location and whether to use Application Default
Credentials or a service-account JSON key, then writes `.df-credentials.json`. For Postgres,
Supabase and MySQL, edit the template `init` wrote instead (see
[Credentials file](#credentials-file)).

| Flag | Default | Description |
|---|---|---|
| `--test-connection` | `true` | Run `SELECT 1` with the new credentials before writing them. `--no-test-connection` skips it. |

### `compile`

```bash
sqlanvil compile [project-dir]
```

Compiles the project and prints a summary of the resulting graph. It never connects to a
warehouse. Exits `1` if the project has compilation errors.

| Flag | Default | Description |
|---|---|---|
| `--json` | `false` | Print the full compiled graph as JSON. This is the file `run --graph` accepts. |
| `--dot` | `false` | Print the dependency graph in Graphviz dot format. Mutually exclusive with `--json`. |
| `--watch` | `false` | Recompile whenever a file in the project changes (ignores `node_modules`). |
| `--actions`, `--tags`, `--include-deps`, `--include-dependents` | | Filter the **printed** graph. The whole project is still compiled, so `ref()`s resolve. See [Selecting actions](#selecting-actions). |
| `--quiet` | `false` | Less verbose output. Mutually exclusive with `--verbose`. |
| `--verbose` | `false` | More verbose output. |
| `--timeout` | none | Maximum time compilation may take, e.g. `30s`. |
| `--no-artifacts` | | Don't write the catalog under `target/`. |

Also accepts every [project-config flag](#project-config-flags).

### `test`

```bash
sqlanvil test [project-dir]
```

Compiles the project and runs its [unit tests](https://sqlanvil.com/docs/reference/test/) (actions
of `type: "test"`) against the warehouse. Exits `1` if any test fails, or if the project has no
unit tests.

| Flag | Default | Description |
|---|---|---|
| `--credentials` | `.df-credentials.json` | Credentials file. See [Other shared flags](#other-shared-flags). |
| `--json` | `false` | Print the test results as JSON. |
| `--timeout` | none | Maximum compilation time. |

Also accepts every [project-config flag](#project-config-flags).

### `validate`

```bash
sqlanvil validate [project-dir]
```

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

| Flag | Default | Description |
|---|---|---|
| `--actions`, `--tags`, `--include-deps`, `--include-dependents` | | Validate only the selected actions. See [Selecting actions](#selecting-actions). |
| `--credentials` | `.df-credentials.json` | Credentials file. |
| `--json` | `false` | Print the per-action results as JSON. |
| `--keep-shadow` | `false` | Leave the shadow schemas in place for debugging. |
| `--timeout` | none | Maximum compilation time. |

Also accepts every [project-config flag](#project-config-flags).

### `run`

```bash
sqlanvil run [project-dir]
```

Compiles the project and executes it against the warehouse named by `warehouse:` in
`workflow_settings.yaml`. Exits `0` only if every action succeeded.

| Flag | Default | Description |
|---|---|---|
| `--actions`, `--tags`, `--include-deps`, `--include-dependents` | | Run only part of the graph. See [Selecting actions](#selecting-actions). |
| `--full-refresh` | `false` | Rebuild incremental tables from scratch. |
| `--dry-run` | | Check the run without applying changes. On **BigQuery** this is BigQuery's server-side dry run. On **Postgres, Supabase and MySQL** it runs [`validate`](#validate), because those warehouses have no native dry run. |
| `--run-tests` | | Run the project's unit tests first, and abort the run if any fail. |
| `--action-retry-limit` | `0` | Retry failed idempotent actions up to this many times. |
| `--graph` | | Run a stored compiled graph (the output of `compile --json`) instead of compiling. What runs is exactly what was compiled. See [Compile once, run later](#compile-once-run-later). |
| `--credentials` | `.df-credentials.json` | Credentials file. |
| `--json` | `false` | Only valid with `--dry-run`. It prints the execution plan (BigQuery) or the validation results (other warehouses) as JSON. Without `--dry-run` the CLI prints a notice and exits without running anything. |
| `--timeout` | none | Maximum **compilation** time. |
| `--execution-timeout` | none | Wall-clock deadline for the **whole run** (compilation plus every action), e.g. `15m`. When it expires, in-flight actions are cancelled, pending ones are skipped and the run fails. |
| `--job-labels` | | BigQuery only. Labels added to every BigQuery job, e.g. `team=data,pipeline=nightly`. |
| `--job-prefix` | | BigQuery only. Prefix for BigQuery job IDs: `--job-prefix nightly` gives `sqlanvil-nightly-<uuid>`. |
| `--no-artifacts` | | Don't write the catalog or run history under `target/`. |

Also accepts every [project-config flag](#project-config-flags).

Restrictions on `--graph`:

- It can't be combined with `--environment`, because environment overrides are applied at compile
  time. Compile with `--environment`, then pass `--credentials` to the run.
- It can't be combined with `--dry-run` on Postgres, Supabase or MySQL, because validation
  recompiles from source. Run `validate` on the project instead.
- If the graph was compiled by a different minor version of sqlanvil, `run` warns but still runs.

### `query`

```bash
sqlanvil query "<sql>" [project-dir]
```

Runs SQL over the project's artifacts with the bundled DuckDB. No warehouse is involved. The
available views are `actions`, `dependencies` and `columns` (written by `compile`) and `runs`
(written by `run`). Run `compile` first.

| Flag | Default | Description |
|---|---|---|
| `--json` | `false` | Print the rows as JSON instead of a table. |

### `inspect`

```bash
sqlanvil inspect [project-dir]
```

Summarizes the artifacts: action counts by type, plus the latest run's status, success and
failure counts, wall time, and up to 20 failures with their error messages.

| Flag | Default | Description |
|---|---|---|
| `--json` | `false` | Print the summary as JSON. |

### `docs`

```bash
sqlanvil docs [project-dir]
```

Writes a self-contained HTML catalog of the project to `target/docs/index.html`, covering models,
types, tags, columns, dependencies and last-run status. It is built from the artifacts, so run
`compile` (or `run`) first. No flags.

### `format`

```bash
sqlanvil format [project-dir]
```

Formats the project's files in place. By default that is every `.sqlx` and `.js` file under
`definitions/` and `includes/`.

| Flag | Default | Description |
|---|---|---|
| `--actions` | `{definitions,includes}/**/*.{js,sqlx}` | For `format`, these are **file globs** relative to the project directory, not action names. |
| `--check` | `false` | Change nothing. Exit `1` if any file would be reformatted. |
| `--ignore-js-files` | `false` | Skip `.js` files (with the default globs, only `.sqlx` is formatted). |

### `introspect`

```bash
sqlanvil introspect <connection> <tableRef> [project-dir]
```

Reads a source table's schema through one of the named `connections:` in `workflow_settings.yaml`
and generates a declaration `.sqlx` with its `columnTypes`. Source types are mapped to the
warehouse's types. `tableRef` is `schema.table`, or just `table`. The source's credentials come
from the `connections` section of `.df-credentials.json`. See
[Foreign Data Wrappers](https://sqlanvil.com/docs/guides/foreign-wrappers/).

| Flag | Default | Description |
|---|---|---|
| `--output` | stdout | Write the declaration to this file instead of printing it. |

### `migrate-dataform`

```bash
sqlanvil migrate-dataform <source-dir> <out-dir>
```

Converts a Dataform project to sqlanvil. The source directory is never modified. The converted
project, plus `migration-report.md` and `migration-report.json`, are written to `out-dir`, which
must be empty. See [Migrate from Dataform](https://sqlanvil.com/docs/guides/migrate-dataform/).

| Flag | Default | Description |
|---|---|---|
| `--target-warehouse` | `supabase` | Where the converted project runs. `supabase` or `postgres` **moves** the warehouse: BigQuery sources become named connections and the SQL gets safe dialect rewrites plus inline `SQLANVIL-MIGRATE` markers. `bigquery` is a **tooling swap**: the project keeps running on BigQuery with its SQL and `bigquery: {}` blocks untouched. |

### `migrate-fix`

```bash
sqlanvil migrate-fix [project-dir]
```

The third phase of a migration (convert, introspect, fix). Run it after the converted project's
declarations have been introspected (`sh scripts/introspect_all.sh`, generated by
`migrate-dataform`). It expands
`SELECT * EXCEPT (...)` into explicit column lists and rewrites `GROUP BY ALL` as positional
ordinals; both need the source columns that introspection provides. It is safe to re-run. It
reports anything it couldn't resolve, rather than guessing, and exits `1` if anything is
unresolved.

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | `false` | Report what would change without writing. |

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

| Flag | Overrides | Description |
|---|---|---|
| `--environment` | | Load a named environment from `environments:` in `workflow_settings.yaml`. That environment's `schemaSuffix`, `vars`, `defaultDatabase`, `defaultLocation` and `credentials` file apply. See [Named Environments](https://sqlanvil.com/docs/guides/environments/). |
| `--default-database` | `defaultProject` | Default database. On BigQuery, the Google Cloud project ID. |
| `--default-schema` | `defaultDataset` | Default schema (a dataset on BigQuery). |
| `--default-location` | `defaultLocation` | BigQuery only. Default location, e.g. `US`. |
| `--assertion-schema` | `defaultAssertionDataset` | Schema that assertions are written to. |
| `--database-suffix` | `projectSuffix` | Suffix appended to database names. |
| `--schema-suffix` | `datasetSuffix` | Suffix appended to schema names, e.g. `dev` gives `analytics_dev`. Letters, digits and underscores only. |
| `--table-prefix` | `namePrefix` | Prefix added to every table name. |
| `--vars` | `vars` | Variables in the form `--vars=key1=value1,key2=value2`, read as `sqlanvil.projectConfig.vars.key1`. Values can't contain `,` or `=`. |
| `--disable-assertions` | | Skip every assertion, built-in (`uniqueKey`, `nonNull`, `rowConditions`) and `type: "assertion"`. |
| `--default-reservation` | `defaultReservation` | BigQuery only. Reservation to run queries in. |

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

`credentials` is the service-account key JSON as a string. Omit it to use Application Default
Credentials (`gcloud auth application-default login`). `accessToken` takes a short-lived OAuth2
token instead, and wins over `credentials`.

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

# BigQuery — project ID and location are required
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
