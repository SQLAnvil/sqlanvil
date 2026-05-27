# npm Publishing

**Status:** Reference / runbook
**Last updated:** 2026-05-27

## 0. TL;DR

- npm organization: **`sqlanvil`** (free tier, public packages)
- Placeholders published 2026-05-27: `@sqlanvil/cli@0.0.1`,
  `@sqlanvil/core@0.0.1`
- Real publish target: Bazel-built tarball at
  `bazel-bin/packages/@sqlanvil/cli/package.tar.gz` (and matching
  for `core`)
- Trigger real publish: when Phase 4 (CLI dispatch) + Phase 3b (Postgres
  SQL generator) land — first usable CLI

## 1. npm Organization

- **Name:** `sqlanvil`
- **Owner:** Ivan Histand (`ihistand` on npm)
- **Plan:** Free (unlimited public packages, no private packages)
- **Created:** 2026-05-27
- **URL:** https://www.npmjs.com/org/sqlanvil

Free plan is sufficient — sqlanvil is OSS, no private packages needed.

## 2. Published Packages

| Package | First version | Date | Status |
| :--- | :--- | :--- | :--- |
| `@sqlanvil/cli` | `0.0.1` | 2026-05-27 | placeholder (name reservation) |
| `@sqlanvil/core` | `0.0.1` | 2026-05-27 | placeholder (name reservation) |

Both placeholders print "not yet published — see GitHub" and exit
non-zero. Source not committed to this repo — was one-shot scaffolding
under `~/sqlanvil-npm-placeholders/` on Ivan's Mac.

### Names to consider claiming later

Don't grab speculatively (npm anti-squatting policy may reclaim
dormant placeholders after 6+ months). Claim when implementation is
within 1-2 phases of needing them:

| Package | Probable timing | Purpose |
| :--- | :--- | :--- |
| `@sqlanvil/postgres` | Phase 3b–4 | If Postgres adapter ships standalone |
| `@sqlanvil/supabase` | Phase 5 | Supabase variant adapter |
| `@sqlanvil/protos` | Phase 4 | Generated TS proto types as standalone module |
| `sqlanvil` (unscoped) | optional | Vanity name — easier `npm i sqlanvil` |

## 3. Real-Publish Workflow

When ready for an actual release (Phase 4 or later):

### 3.1. Build the tarball inside Docker

```bash
cd ~/projects-ivan/sqlanvil
./scripts/docker-bazel build //packages/@sqlanvil/cli:package_tar
# Output: bazel-bin/packages/@sqlanvil/cli/package.tar.gz
```

The tarball is platform-agnostic — pure JS bundle, no native deps in
the tarball itself. Native modules like `pg` are listed in
`package.json` and rebuilt by npm on the consumer's machine.

### 3.2. Extract from container to host

Since `bazel-bin/` symlinks into the Docker named volume, you can't
just `cp` from host. Use:

```bash
docker run --rm \
  -v "$PWD:/workspace" \
  -v sqlanvil-bazel-cache:/root/.cache/bazel \
  -v sqlanvil-bazel-disk:/root/.cache/bazel-disk \
  sqlanvil-dev \
  cp /workspace/bazel-bin/packages/@sqlanvil/cli/package.tar.gz \
     /workspace/sqlanvil-cli.tgz
```

Tarball now at `./sqlanvil-cli.tgz` (host filesystem).

### 3.3. Inspect before publishing

```bash
tar tzf sqlanvil-cli.tgz | head -20
# Should show: package/package.json, package/bundle.js, etc.

tar xzf sqlanvil-cli.tgz -C /tmp/inspect && cat /tmp/inspect/package/package.json
# Verify name + version are what you expect
```

### 3.4. Publish

```bash
npm publish ./sqlanvil-cli.tgz
# Or, if Bazel produces a tarball with non-default options:
npm publish ./sqlanvil-cli.tgz --access public
```

## 4. Version Policy

`0.0.x` — placeholders + early experimental (now)
`0.x.y` — pre-1.0 development. Breaking changes allowed between minors.
`1.0.0` — first stable release. Strict semver after this point.

Bump policy:
- **Patch** (`0.0.1` → `0.0.2`): bugfix, no API change
- **Minor** (`0.1.0` → `0.2.0`): new feature, backwards-compatible
- **Major** (`0.x.y` → `1.0.0`): breaking change OR first stable

Don't ship `0.0.2` until there's something materially worth shipping —
placeholders aren't real releases.

## 5. Future: Automate via CI

Once GitHub Actions is wired (post PR #9 GCP setup), publish becomes
a CI step:

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/docker-bazel build //packages/@sqlanvil/cli:package_tar
      - run: docker cp $(docker create sqlanvil-dev):/workspace/bazel-bin/packages/@sqlanvil/cli/package.tar.gz ./pkg.tgz
      - uses: actions/setup-node@v4
        with:
          registry-url: https://registry.npmjs.org
      - run: npm publish ./pkg.tgz --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Token setup: npm → Profile → Access Tokens → Generate (Automation type)
→ store as `NPM_TOKEN` GitHub secret.

## 6. Auth Notes

- 2FA is enabled by default for new npm accounts since 2025. Each
  `npm publish` from a CLI triggers a browser device-auth flow.
- For automation, use **granular access tokens** (npm Profile → Access
  Tokens → "Granular") scoped only to `@sqlanvil/*` packages. Less
  blast radius than classic legacy tokens.

## 7. References

- [npm scopes docs](https://docs.npmjs.com/cli/v10/using-npm/scope)
- [npm publishing policy](https://docs.npmjs.com/policies/unpublish)
- [Anti-squatting policy](https://docs.npmjs.com/policies/disputes)
- `docs/branch_strategy.md` — repo-side release strategy
- `docs/postgres_first_class_design.md` §9 — phase plan; real publish
  follows Phase 4
