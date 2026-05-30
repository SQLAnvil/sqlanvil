# Contributing to SQLAnvil

Thanks for your interest in SQLAnvil — an open-source SQL workflow tool for BigQuery, PostgreSQL, and Supabase. Contributions of all kinds are welcome: bug reports, docs, adapter improvements, and new features.

## How to contribute (no access request needed)

SQLAnvil follows the standard GitHub **fork-and-pull-request** model. You do **not** need to be granted access to contribute — anyone can fork the repo and open a PR.

1. **Fork** [`sqlanvil/sqlanvil`](https://github.com/sqlanvil/sqlanvil) to your account.
2. **Clone** your fork and branch off `main`:
   ```bash
   git clone git@github.com:<you>/sqlanvil.git
   cd sqlanvil
   git checkout -b my-change
   ```
3. **Make your change**, then build and test (see below).
4. **Push** to your fork and **open a Pull Request** against `sqlanvil/sqlanvil` `main`.

For anything larger than a small fix, **open an issue first** to discuss the approach before writing code.

### Want push access?

There is no self-serve access request — that is by design. The fork-and-PR flow above is the contribution path. If you become a regular contributor and want direct push access, open an issue asking, and reference your merged PRs.

## Build and test

SQLAnvil uses [Bazel](https://bazel.build) for all build and test targets. There are no `npm run` scripts — everything goes through Bazel.

## Prerequisites

- [Bazelisk](https://github.com/bazelbuild/bazelisk) — `npm install -g @bazel/bazelisk`
- Docker (recommended for macOS — see note below)
- Node.js 20 LTS (used by some tooling outside Bazel)

## macOS build note

The pinned Bazel version has toolchain issues with macOS Tahoe (Bazel 5's `wrapped_clang` lacks `LC_UUID`). Use the Docker dev container until the toolchain is modernized:

```bash
# Build anything
./scripts/docker-bazel build //protos:sqlanvil_proto

# Interactive shell
./scripts/docker-bazel
```

## Run the CLI

```bash
# Via the wrapper script (builds first if needed)
./scripts/run help
./scripts/run compile path/to/project
./scripts/run run path/to/project

# Via Bazel directly
bazel run //packages/@sqlanvil/cli:bin -- help
```

## Run tests

```bash
# All tests
bazel test //...

# Core compiler tests only
bazel test //core/...

# Integration tests (requires warehouse credentials)
bazel test //tests/integration/...
```

### Integration test setup

**BigQuery:** Place a GCP service account key at `test_credentials/bigquery.json`.

**Postgres:** The Postgres integration tests use a Docker fixture started by Bazel:

```bash
bazel test //tests/integration:postgres
# Bazel launches tools/postgres/postgres_fixture.ts automatically inside the sandbox
```

## Code style

- TypeScript throughout (no JavaScript in `core/` or `cli/`)
- `tslint.json` and `.prettierrc` at the repo root
- Run `bazel build //...` and `bazel test //...` before submitting a PR

## Package names

All packages are scoped under `@sqlanvil/`:

- `@sqlanvil/core` — compiler and action types
- `@sqlanvil/cli` — command-line interface
- `@sqlanvil/sample-extension` — example extension package

## Pull request guidelines

- **One logical change per PR.** Keep diffs focused and reviewable.
- **Clear description** — what changed and why; link the related issue.
- **Match existing style** (see Code style above). Add or update tests for behavior changes.
- **Adapters generate idiomatic SQL.** The Postgres adapter is not a BigQuery adapter with translated SQL — it emits native Postgres DDL/DML (`INSERT ... ON CONFLICT`, native `CREATE INDEX`, `PARTITION BY RANGE/LIST/HASH`). Don't leak BigQuery quirks (`OPTIONS(...)`, `CLUSTER BY`, `NOT ENFORCED`) into Postgres output.
- **Keep the rename clean.** Don't reintroduce `@dataform/*` package names, `dataform.*` proto packages, or `dataform.json` config in new code.

## Branch strategy

Feature branches target `main`. Postgres/Supabase adapter work proceeds in sequence:

1. `rename/dataform-to-sqlanvil` — rename sweep (complete)
2. `adapter/postgres-first-class` — Postgres adapter, SQL generator, proto changes
3. `adapter/supabase-variant` — Supabase adapter and new action types

## Upstream sync

The `upstream` remote points at `github.com/dataform-co/dataform`. Pull upstream changes before starting new work:

```bash
git fetch upstream
git rebase upstream/main
```

After the rename PR, cherry-picks from upstream will conflict on package names and import paths. Resolve mechanically — the patterns are consistent.
