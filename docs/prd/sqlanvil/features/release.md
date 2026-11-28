<!-- Format: references/prd-format.md, "Requirement blocks". -->

# Release

### FR-025 Build the CLI npm tarball
Status: live (since 2.3.0)
Source: packages/@sqlanvil/cli/BUILD:130 @9cabe4e4
  packages/index.bzl:99 @9cabe4e4
  packages/index.bzl:108 @9cabe4e4
Flow: 1. `bazel build //packages/@sqlanvil/cli:package_tar` → 2. npm_package collects the bundles, manifest, README, LICENSE and NOTICE into `package/` → 3. a genrule tars the sorted file list with `COPYFILE_DISABLE=1` → 4. `bazel-bin/packages/@sqlanvil/cli/package.tar.gz`
Acceptance (EARS):
- AC-025.1 When `//packages/@sqlanvil/cli:package_tar` is built, the packaging rules shall write `package.tar.gz`, a gzip tar archive whose entries are exactly `package/LICENSE`, `package/NOTICE`, `package/README.md`, `package/bundle.js`, `package/package.json` and `package/worker_bundle.js`.
- AC-025.2 The packaging rules shall write the CLI and core tarballs with regular-file entries only: no directory entry (no `package/` entry) and no entry whose base name starts with `._`.
- AC-025.3 The packaging rules shall copy `cli/README.md`, `LICENSE` and `NOTICE` of the repository byte for byte into the CLI tarball as `package/README.md`, `package/LICENSE` and `package/NOTICE`.
Errors: -
Edge cases: a macOS build, whose files carry extended attributes → AC-025.2 (COPYFILE_DISABLE, 8af16e1e); npm 11 rejecting a bare `package/` entry → AC-025.2 (9fc42f67)
Tests: T-025.1 [integration], T-025.2 [integration], T-025.3 [integration]  (test-cases/release.yaml)
Traces: `bazel-bin/packages/@sqlanvil/cli/package.tar.gz`

### FR-026 Build the core npm tarball
Status: approved
Source: packages/@sqlanvil/core/BUILD:111 @9cabe4e4
  packages/@sqlanvil/core/BUILD:46 @9cabe4e4
  packages/index.bzl:113 @9cabe4e4
Flow: 1. `bazel build //packages/@sqlanvil/core:package_tar` → 2. the bundle, its declarations, five protos (each behind the license header), manifest, README, LICENSE and NOTICE go into `package/` → 3. tarred as FR-025 says
Acceptance (EARS):
- AC-026.1 When `//packages/@sqlanvil/core:package_tar` is built, the packaging rules shall write `package.tar.gz` containing the entries `package/bundle.js`, `package/bundle.d.ts`, `package/configs.proto`, `package/core.proto`, `package/db_adapter.proto`, `package/extension.proto`, `package/jit.proto`, `package/LICENSE`, `package/NOTICE`, `package/package.json` and `package/README.md`.
- AC-026.2 The packaging rules shall write each of the five `.proto` entries as the 13-line license header of `packages/index.bzl`, an empty line, then the bytes of `protos/<name>.proto`, and shall copy the repository's root `README.md`, `LICENSE` and `NOTICE` byte for byte as `package/README.md`, `package/LICENSE` and `package/NOTICE`.
Errors: -
Edge cases: `//:version.bzl` is listed in the package's deps but is not in the tarball (E-013); the tarball's entries are what AC-026.1 lists, so the unused dep may stay (not a defect, owner, 2026-11-26)
Tests: T-026.1 [integration], T-026.2 [integration]  (test-cases/release.yaml)
Traces: `bazel-bin/packages/@sqlanvil/core/package.tar.gz`; E-013

### FR-027 Stamp the CLI package manifest
Status: live (since 2.3.0)
Source: packages/@sqlanvil/cli/BUILD:62 @9cabe4e4
  packages/@sqlanvil/cli/BUILD:29 @9cabe4e4
  packages/@sqlanvil/cli/package.layer.json:2 @9cabe4e4
  packages/gen_package_json.ts:44 @9cabe4e4
Flow: 1. pkg_json layers root `package.json`, the shared layer and the CLI layer → 2. sets name, version, description and main → 3. keeps only the 25 externals as dependencies
Acceptance (EARS):
- AC-027.1 The CLI manifest (`package/package.json`) shall have name `@sqlanvil/cli`, version equal to `SQLANVIL_VERSION` in `version.bzl`, description `sqlanvil command line interface.`, main `bundle.js`, bin `{"sqlanvil": "bundle.js"}` and engines `{"node": "^20.19.0 || >=22.12.0"}`.
- AC-027.2 The CLI manifest shall have dependencies with exactly the keys `@duckdb/node-api`, `@google-cloud/bigquery`, `chokidar`, `fs-extra`, `glob`, `google-auth-library`, `google-sql-syntax-ts`, `ignore`, `js-beautify`, `js-yaml`, `long`, `moo`, `mysql2`, `object-sizeof`, `parse-duration`, `pg`, `pg-query-stream`, `promise-pool-executor`, `protobufjs`, `readline-sync`, `semver`, `tmp`, `typeid-js`, `untildify` and `yargs`, each with the version range that the repository's root `package.json` gives it under dependencies.
- AC-027.3 The CLI manifest shall have no devDependencies, packageManager or pnpm key.
- AC-027.4 The CLI manifest's dependency names shall be exactly the external packages that `bundle.js` and `worker_bundle.js` load by a literal `require(...)` or `nativeRequire(...)`, leaving out relative and absolute paths, Node built-ins (with or without `node:`) and `@sqlanvil/core`, with a scoped name counted as its first two path segments and any other name as its first path segment (`mysql2/promise` counts as `mysql2`).
Errors: -
Edge cases: `tarjan-graph` is a root dependency the bundles never load, so it is not declared (109b4058); `@sqlanvil/core` is loaded at run time from the project and never declared
Tests: T-027.1 [integration], T-027.2 [integration], T-027.3 [integration], T-027.4 [integration]  (test-cases/release.yaml)
Traces: `//packages/@sqlanvil/cli:json`

### FR-028 Stamp the core package manifest
Status: live (since 2.3.0)
Source: packages/@sqlanvil/core/BUILD:34 @9cabe4e4
Acceptance (EARS):
- AC-028.1 The core manifest (`package/package.json` of the core tarball) shall have name `@sqlanvil/core`, version equal to `SQLANVIL_VERSION` in `version.bzl`, description `sqlanvil core API.`, main `bundle.js` and dependencies `{}`.
- AC-028.2 The core manifest shall have no bin, engines, types, devDependencies, packageManager or pnpm key.
Errors: -
Tests: T-028.1 [integration], T-028.2 [integration]  (test-cases/release.yaml)
Traces: `//packages/@sqlanvil/core:json`

### FR-029 Carry the shared npm metadata in every package manifest
Status: approved
Source: packages/@sqlanvil/package.layer.json:2 @9cabe4e4
Acceptance (EARS):
- AC-029.1 The manifests of `@sqlanvil/cli`, `@sqlanvil/core` and `@sqlanvil/sample-extension` shall each have homepage `https://sqlanvil.com`, repository `{"type": "git", "url": "git+https://github.com/sqlanvil/sqlanvil.git"}`, bugs `{"url": "https://github.com/sqlanvil/sqlanvil/issues"}`, license `Apache-2.0`, keywords `["sqlanvil", "etl", "data-pipeline", "big-data", "data-modelling", "sql", "bigquery", "dataops", "postgres", "postgresql", "supabase", "mysql"]` and publishConfig `{"access": "public"}`.
Errors: -
Edge cases: the warehouse keywords name all four first-class warehouses (owner, 2026-11-25, Q-19)
Tests: T-029.1 [integration]  (test-cases/release.yaml)
Traces: FR-027, FR-028, FR-035

### FR-030 Generate a package manifest from layers
Status: approved
Source: packages/gen_package_json.ts:21 @9cabe4e4
  packages/gen_package_json.ts:30 @9cabe4e4
  packages/gen_package_json.ts:41 @9cabe4e4
  packages/gen_package_json.ts:44 @9cabe4e4
  packages/gen_package_json.ts:51 @9cabe4e4
  packages/index.bzl:20 @9cabe4e4
Flow: 1. `gen-package-json-bin --name --description --package-version [--main] [--types] --output-path --layer-paths … [--external-dependencies …]` → 2. reads each layer as JSON and merges them → 3. applies the overrides → 4. strips workspace fields → 5. keeps the listed dependencies → 6. writes the output path
Acceptance (EARS):
- AC-030.1 When the generator is given several layer files, it shall merge their top-level keys in the order given, a later layer's value replacing an earlier one's for the same key, the keys keeping the order of first appearance.
- AC-030.2 The generator shall set version, name and description from `--package-version`, `--name` and `--description`, replacing any layer value.
- AC-030.3 The generator shall set main and types only when `--main` and `--types` are non-empty, and otherwise leave the merged layers' keys as they are.
- AC-030.4 The generator shall remove the devDependencies, packageManager and pnpm keys from the result.
- AC-030.5 The generator shall set dependencies to an object holding only the packages named by `--external-dependencies`, in that order, each with the range the merged layers' dependencies give it, and to `{}` when none are named.
- AC-030.6 The generator shall write the result to `--output-path` as JSON indented with 4 spaces and no final newline.
- AC-030.7 If a package named by `--external-dependencies` is not in the merged layers' dependencies object, the generator shall fail with the error `Dependency does not appear to be installed in root package.json: <name>`, exit non-zero and write no output file.
- AC-030.8 If no layer has a dependencies object and `--external-dependencies` names a package, the generator shall fail with the error of AC-030.7 for the first package named, exit non-zero and write no output file.
Errors: PACKAGE_DEPENDENCY_NOT_INSTALLED (contracts/errors.yaml)
Edge cases: no layer has a dependencies object while an external is named → AC-030.8 (E-017)
Tests: T-030.1 [integration], T-030.2 [integration], T-030.3 [integration], T-030.4 [integration], T-030.5 [integration], T-030.6 [integration], T-030.7 [integration], T-030.8 [integration]  (test-cases/release.yaml)
Traces: FR-027, FR-028, FR-035; E-017

### FR-031 Bundle the CLI with rollup
Status: live (since 2.3.0)
Source: packages/index.bzl:45 @9cabe4e4
  packages/rollup.config.mjs:41 @9cabe4e4
  packages/rollup.config.mjs:63 @9cabe4e4
  packages/rollup.config.mjs:80 @9cabe4e4
  packages/rollup.config.mjs:84 @9cabe4e4
  packages/@sqlanvil/cli/BUILD:76 @9cabe4e4
  packages/@sqlanvil/cli/BUILD:93 @9cabe4e4
  packages/index.bzl:113 @9cabe4e4
Flow: 1. rollup bundles `packages/@sqlanvil/cli/index.js` (calls runCli) and `//cli/vm:worker.js` as CommonJS, inlining `sa/...` → 2. leaves externals, `@sqlanvil/core` and dynamic requires to run time → 3. a genrule puts a shebang and the license header in front
Acceptance (EARS):
- AC-031.1 The packaging rules shall write `bundle.js` and `worker_bundle.js` of the CLI package with line 1 `#!/usr/bin/env node`, lines 2 to 14 the 13-line license header of `packages/index.bzl` (from `// Copyright 2023 Google LLC` to `// limitations under the License.`) and line 15 empty.
- AC-031.2 The CLI bundler shall inline every `sa/...` module, so neither bundle holds a `require` of a specifier that starts with `sa/`, and shall leave each listed external as a run-time `require` (for example `require('yargs')` in `bundle.js`) and `@sqlanvil/core` as a run-time `require("@sqlanvil/core")` in `worker_bundle.js`.
- AC-031.3 If a bundled module imports a bare specifier that is not `sa` or `sa/...`, is not a listed external or a path under an unscoped listed external, and is not (with `ALLOW_NODE_BUILTINS`) one of `path`, `fs`, `os`, `util`, `child_process`, `crypto`, `events`, `https`, `net`, `module` or `vm`, rollup with `packages/rollup.config.mjs` shall fail with the error `Must explicitly list import as an external: <specifier>`.
- AC-031.4 The CLI bundler shall leave the non-literal `nativeRequire` call in place, so `bundle.js` holds `nativeRequire)("@duckdb/node-api")` and loads `@duckdb/node-api` at run time.
Errors: BUNDLE_IMPORT_NOT_EXTERNAL (contracts/errors.yaml)
Tests: T-031.1 [integration], T-031.2 [integration], T-031.3 [integration], T-031.4 [integration]  (test-cases/release.yaml)
Traces: FR-025, FR-027

### FR-032 Bundle core with webpack
Status: live (since 2.3.0)
Source: packages/@sqlanvil/core/BUILD:17 @9cabe4e4
  packages/@sqlanvil/core/index.ts:1 @9cabe4e4
  packages/@sqlanvil/core/webpack.config.js:4 @9cabe4e4
  packages/@sqlanvil/core/BUILD:82 @9cabe4e4
  packages/rollup_dts.config.mjs:5 @9cabe4e4
Acceptance (EARS):
- AC-032.1 The packaging rules shall write the core `bundle.js` with lines 1 to 13 the license header of `packages/index.bzl` and line 14 empty, with no shebang line.
- AC-032.2 When the core `bundle.js` is loaded with Node's `require`, it shall export compiler, indexFileGenerator, jitCompiler, main, session, supportedFeatures and version, with version equal to `SQLANVIL_VERSION` in `version.bzl`.
- AC-032.3 The packaging rules shall write the core `bundle.d.ts` so that its only import or export `from` specifiers are `long` and `protobufjs`.
- AC-032.4 If the environment variable `BAZEL_BINDIR` is not set, the webpack configurations of core and of the sample extension shall throw the error `BAZEL_BINDIR must be set`.
Errors: CORE_BUNDLE_BINDIR_UNSET (contracts/errors.yaml)
Tests: T-032.1 [integration], T-032.2 [integration], T-032.3 [integration], T-032.4 [integration]  (test-cases/release.yaml)
Traces: FR-026

### FR-033 Publish a package with its publish target
Status: live (since 2.3.0)
Source: packages/index.bzl:96 @9cabe4e4
  packages/@sqlanvil/cli/BUILD:140 @9cabe4e4
  packages/@sqlanvil/core/BUILD:127 @9cabe4e4
Flow: `bazel run //packages/@sqlanvil/{core,cli}:package.publish -- <npm publish args>` runs `npm publish` on the package directory (rules_js `publishable`)
Acceptance (EARS):
- AC-033.1 When `//packages/@sqlanvil/core:package.publish` is run with `--dry-run` and a `--registry` address, the publish target shall run `npm publish` on the core package directory, exit 0, report `@sqlanvil/core@` followed by `SQLANVIL_VERSION`, and upload nothing to that registry.
Errors: NPM_PUBLISH_FAILED (contracts/errors.yaml)
Tests: T-033.1 [integration]  (test-cases/release.yaml)
Traces: `contracts/dependencies/npm-registry.yaml`

### FR-034 Run the CLI from source with the dev entry point
Status: live (since 2.3.0)
Source: packages/@sqlanvil/cli/BUILD:17 @9cabe4e4
  packages/@sqlanvil/cli/bin_loader.js:3 @9cabe4e4
Flow: `bazel run //packages/@sqlanvil/cli:bin -- <args>` (testonly; the working directory is `$BUILD_WORKING_DIRECTORY`) → bin_loader installs `testing/resolver-patch.js` → runs `index.js` (runCli)
Acceptance (EARS):
- AC-034.1 When `//packages/@sqlanvil/cli:bin` is run with `--version`, the dev entry point shall run the CLI from source and print `sqlanvil <SQLANVIL_VERSION> (Dataform core <DF_VERSION>)` with the two values of `version.bzl`, and exit 0.
Errors: -
Tests: T-034.1 [integration]  (test-cases/release.yaml)
Traces: `scripts/run` (outside the boundary)

### FR-035 Build the sample extension package
Status: approved
Source: packages/sample-extension/index.ts:6 @9cabe4e4
  packages/sample-extension/index.ts:19 @9cabe4e4
  packages/sample-extension/BUILD:34 @9cabe4e4
  packages/sample-extension/BUILD:63 @9cabe4e4
Acceptance (EARS):
- AC-035.1 When the extension that `extension()` returns compiles a request with neither var set, the sample extension shall publish one action named `sample-action` whose query is `SELECT 1 as sample_id` into the session.
- AC-035.2 If the request's project config override has the var `throw-error` set to `"true"`, the sample extension shall throw the error `throwing exception as requested!` and publish nothing.
- AC-035.3 If the request's project config override has the var `store-compile-error` set to `"true"`, the sample extension shall record the compilation error `storing compilation error as requested!` in the session and still publish `sample-action`.
- AC-035.4 The sample-extension manifest shall have name `@sqlanvil/sample-extension`, version equal to `SQLANVIL_VERSION`, description `Sample extension.`, main `bundle.js` and dependencies `{}`.
- AC-035.5 When `//packages/sample-extension:package_tar` is built, the packaging rules shall write a tarball containing `package/bundle.js`, `package/bundle.d.ts` and `package/package.json`.
Errors: -
Edge cases: `//:version.bzl` is listed in the package's deps but not in the tarball (E-013); the tarball's entries are what AC-035.5 lists, so the unused dep may stay (not a defect, owner, 2026-11-26). The package has no publish target (no `publishable`): intended, it is a test fixture for core's extension tests and stays unpublished (owner, 2026-11-25, Q-20)
Tests: T-035.1 [integration], T-035.2 [integration], T-035.3 [integration], T-035.4 [integration], T-035.5 [integration]  (test-cases/release.yaml)
Traces: core extension tests (`core/main_test.ts`, outside the boundary); E-013

### FR-036 Build the GitHub release title and notes from whats-new
Status: approved
Source: scripts/release_github:21 @9cabe4e4
  scripts/release_github:22 @9cabe4e4
  scripts/release_github:26 @9cabe4e4
  scripts/release_github:30 @9cabe4e4
  scripts/release_github:33 @9cabe4e4
  scripts/release_github:37 @9cabe4e4
  scripts/release_github:44 @9cabe4e4
Flow: 1. cd to the repository root → 2. version from `VERSION` or `version.bzl` → 3. reads `WHATS_NEW` → 4. header line `## <version> …` gives the title → 5. section body gives the notes
Acceptance (EARS):
- AC-036.1 When `VERSION` is unset or empty, release_github shall use the `SQLANVIL_VERSION` value of the repository's `version.bzl` as the version, and when `VERSION` is set to a non-empty value it shall use that value; the tag is `v<version>`.
- AC-036.2 When `WHATS_NEW` is unset, release_github shall read `../sqlanvil-com/src/content/docs/docs/whats-new.md` relative to the repository root, and when it is set it shall read that path.
- AC-036.3 If the whats-new file does not exist, release_github shall print `whats-new not found: <path> (set WHATS_NEW=...)` to stderr and exit 1, creating no tag and no release.
- AC-036.4 If the whats-new file has no line that starts with `## <version> `, release_github shall print `no '## <version>' section in <path> — add the release entry first` to stderr and exit 1, creating no tag and no release.
- AC-036.5 The release title shall be `v<version> — <headline>`, where `<headline>` is the first `## <version> ` line with `## ` and the version removed and then every leading character that is not a letter, a digit, `(` or a backtick removed.
- AC-036.6 The release notes shall be the lines after that header line up to the next line that starts with `## ` (or the end of the file), trailing empty lines removed, every `](/docs/` replaced by `](https://sqlanvil.com/docs/`, followed by an empty line and the line ``**Install:** `npm i -g @sqlanvil/cli@<version>` ``.
- AC-036.7 If `VERSION` is unset or empty and `version.bzl` has no `SQLANVIL_VERSION` line, release_github shall print `could not read SQLANVIL_VERSION from version.bzl` to stderr and exit 1, creating no tag and no release.
Errors: RELEASE_WHATS_NEW_NOT_FOUND, RELEASE_NOTES_SECTION_MISSING, RELEASE_VERSION_UNREADABLE (contracts/errors.yaml)
Edge cases: version.bzl without SQLANVIL_VERSION → AC-036.7 (E-015); a prerelease version such as `1.0.0-beta.0` keeps `-beta.0 — ` partly in the headline (the runbook releases real versions only)
Tests: T-036.1 [integration], T-036.2 [integration], T-036.3 [integration], T-036.4 [integration], T-036.5 [integration], T-036.6 [integration], T-036.7 [integration]  (test-cases/release.yaml)
Traces: `sqlanvil-com` `docs/whats-new.md`; E-015

### FR-037 Preview a GitHub release with DRY_RUN
Status: live (since 2.3.0)
Source: scripts/release_github:50 @9cabe4e4
  scripts/release_github:56 @9cabe4e4
Acceptance (EARS):
- AC-037.1 When `DRY_RUN` is `1`, release_github shall print the lines `Version : <version>`, `Tag     : v<version>  (commit <first 9 characters of the release commit>)`, `Title   : <title>` and `Notes   :`, then each notes line prefixed with `  | `, then `[dry-run] would tag + push v<version> and create/update the release`, and exit 0.
- AC-037.2 When `DRY_RUN` is `1`, release_github shall create no tag, push nothing, run no `gh` command and leave no notes file in the temporary directory.
Errors: -
Edge cases: AC-037.2's "no notes file in the temporary directory" has no test: on macOS `mktemp` ignores `TMPDIR`, so a test cannot watch the directory the notes file goes to (owner, 2026-11-26, D1)
Tests: T-037.1 [integration], T-037.2 [integration]  (test-cases/release.yaml)
Traces: FR-036

### FR-038 Tag the release commit and create or update the GitHub release
Status: approved
Source: scripts/release_github:47 @9cabe4e4
  scripts/release_github:62 @9cabe4e4
  scripts/release_github:65 @9cabe4e4
  scripts/release_github:68 @9cabe4e4
  scripts/release_github:76 @9cabe4e4
Flow: 1. release commit = the newest commit reachable from HEAD whose message matches `release: SQLAnvil <version>` or `SQLANVIL_VERSION.*<version>`, else HEAD → 2. annotated tag if missing → 3. `git push origin v<version>` → 4. `gh release view` → edit or create in SQLAnvil/sqlanvil, always `--latest`
Acceptance (EARS):
- AC-038.1 When one or more commits reachable from HEAD have a message matching `release: SQLAnvil <version>`, release_github shall use the newest of them as the release commit, even when a later commit's message matches `SQLANVIL_VERSION.*<version>`.
- AC-038.2 When no commit reachable from HEAD has a message matching either pattern, release_github shall use HEAD as the release commit.
- AC-038.3 When the tag `v<version>` does not exist locally, release_github shall create it as an annotated tag on the release commit with the release title as its message; when it exists, it shall leave it unchanged; in both cases it shall then push `v<version>` to the remote `origin`.
- AC-038.4 When `gh release view v<version> --repo SQLAnvil/sqlanvil` fails and the version is the `SQLANVIL_VERSION` of `version.bzl`, release_github shall run `gh release create v<version> --repo SQLAnvil/sqlanvil --verify-tag --latest --title <title> --notes-file <notes file>`.
- AC-038.5 When `gh release view v<version> --repo SQLAnvil/sqlanvil` succeeds and the version is the `SQLANVIL_VERSION` of `version.bzl`, release_github shall print `Release v<version> exists — updating title/notes.` and run `gh release edit v<version> --repo SQLAnvil/sqlanvil --title <title> --notes-file <notes file> --latest`.
- AC-038.6 When the release is created or updated, release_github shall remove its notes file, print `Done: https://github.com/SQLAnvil/sqlanvil/releases/tag/v<version>` and exit 0.
- AC-038.7 If `git push` or the `gh` create or edit command fails, release_github shall stop at that command and exit non-zero.
- AC-038.8 When no commit reachable from HEAD has a message matching `release: SQLAnvil <version>` and one or more match `SQLANVIL_VERSION.*<version>`, release_github shall use the newest of those as the release commit.
- AC-038.9 When `VERSION` is set to a version other than the `SQLANVIL_VERSION` of `version.bzl`, release_github shall create or edit the release as AC-038.4 and AC-038.5 say but without `--latest`, so the release GitHub marks Latest does not change.
Errors: RELEASE_GITHUB_FAILED (contracts/errors.yaml)
Edge cases: a later commit matching `SQLANVIL_VERSION.*<version>`, such as the next bump → AC-038.1 (E-014); re-running for an older version to fix its notes → AC-038.9 (owner, 2026-11-25, Q-16)
Tests: T-038.1 [integration], T-038.2 [integration], T-038.3 [integration], T-038.4 [integration], T-038.5 [integration], T-038.6 [integration], T-038.7 [integration], T-038.8 [integration], T-038.9 [integration]  (test-cases/release.yaml)
Traces: `contracts/dependencies/github.yaml`; E-014

### FR-039 Bump DF_VERSION's patch with update_version
Status: removed (since 2.3.0)
Source: scripts/update_version:8 @9cabe4e4
  scripts/update_version:11 @9cabe4e4
  scripts/update_version:14 @9cabe4e4
  scripts/update_version:27 @9cabe4e4
Flow: reads `version.bzl` in the current directory → splits DF_VERSION on `.` and `-` → patch + 1 → rewrites the DF_VERSION line in place → prints the new version
Acceptance (EARS):
- AC-039.1 When update_version runs in a directory whose `version.bzl` has `DF_VERSION = "<major>.<minor>.<patch>"` with a non-zero patch, it shall rewrite that line to `DF_VERSION = "<major>.<minor>.<patch + 1>"`, leave every other line of the file unchanged and print `Version updated to: <new version>`.
- AC-039.2 When DF_VERSION carries a label after a hyphen (`<major>.<minor>.<patch>-<label>`, non-zero patch), update_version shall keep the label: `<major>.<minor>.<patch + 1>-<label>`.
Errors: -
Edge cases: retired (owner, 2026-11-25, Q-15): DF_VERSION is set by hand at each upstream sync and the review is recorded in `version.bzl`'s notes; the script, which aborts on a patch of 0 (E-016) and needs GNU `grep -P` and `sed -i` (Q-14), is deleted
Traces: E-016

### FR-040 Refuse to regenerate the reference pages without the site or the Bazel outputs
Status: verified
Source: scripts/regenerate_docs:19 @b6bf0230
  scripts/regenerate_docs:28 @8d9db0f4
  scripts/regenerate_docs:62 @8d9db0f4
  scripts/regenerate_docs:65 @8d9db0f4
Acceptance (EARS):
- AC-040.1 If `<COM_REPO>/src/content/docs/docs/reference` is not a directory (COM_REPO defaults to `../sqlanvil-com`), regenerate_docs shall print `ERROR: <COM_REPO>/src/content/docs/docs/reference not found. Clone the site repo: git clone git@github.com:SQLAnvil/sqlanvil-com.git <COM_REPO>` to stdout and exit 1, writing nothing.
- AC-040.2 If `bazel-bin/protos/ts.d.ts` or `bazel-bin/core/version.ts` under the repository root is missing, regenerate_docs shall print `bazel-bin/<file> missing — run: bazel build //protos:ts //core:version` to stderr, for the first missing one in that order, and exit 1, leaving the site's reference pages unchanged.
- AC-040.3 When regenerate_docs exits after the site check passed, whether it succeeds or fails, it shall remove `protos/ts.d.ts`, `core/version.ts`, `newdocs/` and `.docs_gen/` from the repository root.
- AC-040.4 When `COM_REPO` is unset, regenerate_docs shall look for the site at `../sqlanvil-com` relative to the repository root, whatever directory it is run from.
Errors: DOCS_SITE_NOT_FOUND, DOCS_BAZEL_OUTPUT_MISSING (contracts/errors.yaml)
Edge cases: run from a directory other than the repository root → AC-040.4 (owner, 2026-11-25, Q-17)
Tests: T-040.1 [integration], T-040.2 [integration], T-040.3 [integration], T-040.4 [integration]  (test-cases/release.yaml)

### FR-041 Regenerate the reference pages into sqlanvil-com
Status: live (since 2.3.0)
Source: scripts/regenerate_docs:36 @9cabe4e4
  scripts/regenerate_docs:67 @9cabe4e4
  scripts/regenerate_docs:72 @9cabe4e4
  scripts/regenerate_docs:85 @9cabe4e4
  scripts/regenerate_docs:102 @9cabe4e4
Flow: 1. copies the two Bazel outputs → 2. installs typedoc under `tools/typedoc` on first use and runs it → 3. post-processes 11 class pages → 4. builds the protoc-gen-doc image if missing and generates `configs.md` → 5. writes each page's body under its front matter
Acceptance (EARS):
- AC-041.1 When regenerate_docs runs to the end, it shall write the pages `session.md`, `assertion.md`, `table.md`, `view.md`, `incrementaltable.md`, `operation.md`, `notebook.md`, `test.md`, `declaration.md`, `export.md`, `import.md` and `configs.md` under the reference directory, print `Generated JS-API reference pages into <reference dir>` and `Generated configs.md into <reference dir>` with the directory as an absolute path, and exit 0.
- AC-041.2 When a reference page exists and its first line is `---`, regenerate_docs shall keep its lines up to and including the next `---` line, then write one empty line and the generated body in place of the rest.
- AC-041.3 When a reference page does not exist or its first line is not `---`, regenerate_docs shall replace the whole page with the generated body.
- AC-041.4 If typedoc emits no class page for one of the 11 JS-API pages, regenerate_docs shall print `WARNING: typedoc did not emit <stem>.md — skipping <slug>`, leave that page unchanged and go on with the others.
- AC-041.5 If the Docker image named by `PROTOC_GEN_DOC_IMAGE` (default `protoc-gen-doc:camelcase`) is not present locally, regenerate_docs shall print `Image <image> not found — building it...` and run `tools/protoc-gen-doc/build-image.sh` before generating `configs.md`.
Errors: -
Edge cases: action classes not in the page list (script, rls_policy, vector_index, realtime_publication, extract, foreign_table) get no page: intended, a page is added deliberately, by adding the class to the script's page list; their config keys are in `configs.md` (owner, 2026-11-25, Q-18)
Tests: T-041.1 [warehouse], T-041.2 [warehouse], T-041.3 [warehouse], T-041.4 [warehouse], T-041.5 [warehouse]  (test-cases/release.yaml)
Traces: `sqlanvil-com` `src/content/docs/docs/reference/`

### FR-042 Ship no script that bumps DF_VERSION
Status: verified
Flow: DF_VERSION in `version.bzl` is edited by hand at each upstream sync, and the review is recorded in `version.bzl`'s notes; no script in the repository bumps it
Acceptance (EARS):
- AC-042.1 The repository shall hold no file at `scripts/update_version`.
Errors: -
Edge cases: replaces the removed FR-039 (owner, 2026-11-25, Q-15); added for E-016 (owner, 2026-11-26)
Tests: T-042.1 [integration]  (test-cases/release.yaml)
Traces: E-016
