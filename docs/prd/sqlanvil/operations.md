<!-- Format: references/prd-format.md, "operations.md". -->

# Operations

A release publishes `@sqlanvil/core` and then `@sqlanvil/cli` to npm, then tags `vX.Y.Z` and
creates the GitHub release. npm publishing stays manual because the npm account uses two-factor
authentication. The steps below are taken from the repository's release notes
(`SQLAnvil/docs`, `npm_publishing.md` §3) and `scripts/release_github`. A prerelease is built with
`SQLANVIL_VERSION = "X.Y.Z-beta.N"` and published with `--tag beta` to the `npm-beta` environment;
a version number is never reused.

## Environments

| Environment | URL | Production |
|---|---|---|
| npm-beta | https://www.npmjs.com/package/@sqlanvil/cli?activeTab=versions | no |
| npm | https://www.npmjs.com/package/@sqlanvil/cli | yes |

## Runbook

1. Approve the release (actor: human) (env: npm)
   Do: check that `SQLANVIL_VERSION` in `version.bzl` is the version to release and that the sqlanvil-com `whats-new.md` has its `## X.Y.Z` entry, then reply "release X.Y.Z"
   Check: the reply names the version in `version.bzl`
2. Build the package tarballs (actor: agent) (env: npm)
   Run: `bazel build //packages/@sqlanvil/cli:package_tar //packages/@sqlanvil/core:package_tar`
   Check: `tar tzf bazel-bin/packages/@sqlanvil/cli/package.tar.gz` prints `package/package.json`
3. Publish @sqlanvil/core (actor: human) (env: npm)
   Do: run `npm login`, then `npm publish` on the core tarball with `--access public`, and wait until `npm view @sqlanvil/core@X.Y.Z version --prefer-online` prints the version
   Check: the owner reports that the core version is listed on the registry
4. Publish @sqlanvil/cli (actor: human) (env: npm)
   Do: run `npm publish` on the cli tarball with `--access public`
   Check: the owner reports that `npm view @sqlanvil/cli@X.Y.Z version --prefer-online` prints the version
5. Tag and create the GitHub release (actor: agent) (env: npm)
   Run: `./scripts/release_github`
   Check: [NEEDS CLARIFICATION: a backticked command that shows the GitHub release for the version is the latest, then prints or matches its expected output]
6. Release sync (actor: human) (env: npm)
   Do: update the five places that move with every release (sqlanvil-com docs, `AGENTS.md` version pins, SQLAnvil/agent-skills, the sqlanvil-toolkit plugin, SQLAnvil Cloud's pins), per `npm_publishing.md` §3.6
   Check: the owner reports each of the five is done

## Secrets

- The npm publish credential: the maintainer's own `npm login` session with two-factor authentication; never stored in the repository.
- `test_credentials/bigquery.json`: the BigQuery test project's credentials for the integration level; git-ignored, never committed. [NEEDS CLARIFICATION: where the BigQuery test credential is stored and who holds it]
