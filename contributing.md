# Contributing

sqlanvil is a TypeScript project, using [Bazel](https://bazel.build) as a build tool.

## Getting Started

[Fork the repository](https://github.com/ihistand/sqlanvil/fork), clone it, and navigate inside.

### Requirements

#### [Bazel](https://bazel.build)

Bazel is the build system. Install via Bazelisk:

```bash
brew install bazelisk          # macOS
# or:
npm i -g @bazel/bazelisk
```

On macOS, increase the open-file limit (Bazel hits the default):

```bash
sudo sysctl -w kern.maxfiles=65536
```

##### macOS compatibility (important)

The currently pinned Bazel 5.4 + 2022-era protobuf chain inherited from
upstream **does not build natively on macOS Tahoe / Apple Silicon** —
`wrapped_clang` ships without `LC_UUID` (rejected by current dyld) and the
old protobuf headers conflict with Xcode 21's SDK. This will be fixed by
a future toolchain modernization PR (Bazel 7 + Bzlmod migration).

Until then, build via Docker on macOS:

```bash
./scripts/docker-bazel build //protos:sqlanvil_proto
./scripts/docker-bazel test //core/...
./scripts/docker-bazel build //...
./scripts/docker-bazel                    # drops into an interactive shell
```

The wrapper builds a `sqlanvil-dev` image (Debian + Node 20 + JDK 17 +
Bazelisk) on first invocation and reuses named volumes for the Bazel cache
so subsequent runs are fast.

Linux users can use Bazelisk directly without Docker.

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
