# Contributing

sqlanvil is a TypeScript project, using [Bazel](https://bazel.build) as a build tool.

## Getting Started

[Fork the repository](https://github.com/ihistand/sqlanvil/fork), clone it, and navigate inside.

### Requirements

#### [Bazel](https://bazel.build)

Bazel is the build system. Install via Bazelisk:

```bash
npm i -g @bazel/bazelisk
```

On macOS, increase the open-file limit (Bazel hits the default):

```bash
sudo sysctl -w kern.maxfiles=65536
```

### Run the CLI

Substitute `./scripts/run` for the installed `sqlanvil` binary:

```bash
./scripts/run help
./scripts/run compile path/to/project
```

### Test

```bash
bazel test //core/...             # core compiler tests
bazel test //...                  # everything (slow on cold cache)
```

### Integration Tests

Integration tests require real warehouse credentials. The upstream
`test_credentials` GCP project is no longer accessible; you'll need to wire
your own.

For BigQuery integration tests:

1. Create a GCP service account with BigQuery access.
2. Download the key JSON.
3. Update constants in `cli/index_test_base.ts` to match your project
   (`DEFAULT_DATABASE`, `DEFAULT_LOCATION`, `CREDENTIALS_PATH`).
4. `bazel test //cli:index_test`.

For Postgres integration tests, `tools/postgres/postgres_fixture.ts` boots a
Docker container inside the Bazel sandbox — requires Docker running locally.

### Building

```bash
bazel build cli                   # build the CLI
bazel build //...                 # build everything
```

### Adding NPM Dependencies

Use Bazel-wrapped yarn:

```bash
bazel run @nodejs//:yarn add <package>
```

After installation, add the package to relevant `ts_library` deps prefixed
with `@npm//`.

## Pull Requests

- Keep PRs small and focused — small diffs are easier to review.
- Add tests when changing behavior.
- Don't reformat unrelated code (makes diffs noisy).
- Branch off `main`.

## Reporting Issues

[Open an issue](https://github.com/ihistand/sqlanvil/issues) on GitHub.
