# Contributing to SQLAnvil

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

## Branch strategy

Three sequential PRs against `restore-postgres-adapter`:

1. `rename/dataform-to-sqlanvil` — rename sweep (already complete)
2. `adapter/postgres-first-class` — Postgres adapter, SQL generator, proto changes
3. `adapter/supabase-variant` — Supabase adapter and new action types

## Upstream sync

The `upstream` remote points at `github.com/dataform-co/dataform`. Pull upstream changes before starting new work:

```bash
git fetch upstream
git rebase upstream/main
```

After the rename PR, cherry-picks from upstream will conflict on package names and import paths. Resolve mechanically — the patterns are consistent.
