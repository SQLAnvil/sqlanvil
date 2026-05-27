# Rename Handoff

Snapshot of the `rename/dataform-to-sqlanvil` branch state for picking
back up after a break.

## Status

**Logically complete + proto layer verified building.** Ready for review
and merge into `restore-postgres-adapter`. Larger Bazel targets blocked
by pre-existing upstream toolchain rot (separate from the rename — see
"Known pre-existing issues" below).

## Where to pick up

```bash
cd ~/projects-ivan/sqlanvil
git checkout rename/dataform-to-sqlanvil
git log --oneline restore-postgres-adapter..HEAD     # see the 10 rename commits
```

## What was verified

**Proto-layer build succeeded inside Docker:**

```bash
./scripts/docker-bazel build //protos:sqlanvil_proto
# → Build completed successfully, 4 total actions
```

That proves:
- New WORKSPACE name `sa` (was `df`) is accepted by Bazel
- Target `//protos:sqlanvil_proto` (was `//protos:dataform_proto`) resolves
- All 8 `.proto` files parse with `package sqlanvil;`
- `java_package = "com.sqlanvil.protos"` + `go_package = "github.com/ihistand/sqlanvil/..."` accepted
- Wire-format-breaking field rename `sqlanvil_core_version` accepted
- `@com_google_protobuf//` external resolves and the C++ chain compiles

## What was NOT verified (and why)

| Target | Blocker | Type |
| :--- | :--- | :--- |
| `//protos:ts` | Node v24.13.0 pin in WORKSPACE has stale SHA256 — nodejs.org served a different binary | Pre-existing upstream pin drift |
| `//core/...` | Same node pin issue (transitive) | Pre-existing |
| `bazel test //...` | Same | Pre-existing |
| `./scripts/run help` (CLI smoke) | Same | Pre-existing |
| Native macOS build | Bazel 5.4 `wrapped_clang` lacks `LC_UUID` (rejected by Tahoe dyld); Bazel 6.x WORKSPACE `@bazel_tools//platforms` refactor breaks too | Pre-existing macOS+toolchain rot |

All five would fail identically on `upstream/main` — not caused by this
PR.

## Commits on the branch

```
63685541 fix(protos): strip_import_prefix + add timestamp_proto dep
05e2...   build: Dockerfile.dev + scripts/docker-bazel for macOS users
ce6af2eb refactor: final rename sweep — proto auto-docs + goldens + examples + dead infra
31adafa6 refactor: rename interface ID + write NOTICE + rewrite root docs
9809e459 refactor: rename CLI binary + help text + VSCode extension
1399c23d refactor: drop dataform.json legacy config path (clean break)
513e6963 refactor: rename TS imports df/ → sa/ + proto namespace + framework defaults
2148bb3e refactor: rename packages/@dataform → @sqlanvil + Bazel labels + dead infra
f084b0ae refactor: rename proto packages dataform → sqlanvil + WORKSPACE
b4b24cd6 docs: rename plan + postgres-first-class design
```

Total: ~150 files changed, ~2400 lines net (mostly mechanical renames).

## Known pre-existing issues (NOT introduced by this PR, but blocking
verification beyond proto layer)

### 1. Node v24.13.0 SHA256 mismatch
`WORKSPACE` pins `node-v24.13.0-linux-arm64.tar.xz` with checksum
`e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e`.
nodejs.org currently serves a binary with checksum
`aa881151bd0f9f154a0424dd60a72e9ce10672619121658c278a24327ef46831`.
Fix: bump pin to a current Node release (probably 20 LTS to match the
Docker image, or 22 LTS) and regenerate SHA. Likely also needs matching
amd64 SHA.

### 2. Bazel toolchain modernization needed for native macOS builds
The pinned Bazel 5.4 was released Dec 2022. Its `wrapped_clang` shim
binary doesn't include `LC_UUID` load commands, which macOS Tahoe's
dyld rejects. Bumping to Bazel 6+ hits a different problem
(`@bazel_tools//platforms` removed; WORKSPACE references it).

Real fix is multi-day work: bump to Bazel 7 LTS, migrate WORKSPACE to
`MODULE.bazel` (Bzlmod), update `rules_proto`/`rules_nodejs`/`protobuf`
versions to match.

### 3. proto_library bugs in upstream Dataform too
The `import "extension.proto"` (no `protos/` prefix) and missing
`timestamp_proto` dep were both present in `upstream/main`. Likely
masked by upstream CI only running through `ts_proto_library` rather
than building the proto_library target directly.

Fixed in this PR (commit `63685541`).

## Next steps (in priority order)

1. **Open a PR** for the rename branch against `restore-postgres-adapter`.
   Use the commit summaries as the PR body. Mark "verified at proto layer
   via Docker, blocked on toolchain rot for fuller verification."

2. **Small follow-up PR: refresh stale toolchain pins.**
   - Update WORKSPACE node version (v24.13.0 → v20.x or v22.x LTS) with
     matching SHA256 hashes for arm64 + amd64
   - This should unblock `//protos:ts`, then `//core/...`, then full tree
   - Scope: 1-2 hour PR. Mechanical.

3. **Then start the Postgres adapter PR** as planned in
   `docs/postgres_first_class_design.md` §9 (PR 2:
   `adapter/postgres-first-class`).

4. **Defer until needed: Bazel 7 + Bzlmod modernization.** Would unblock
   native macOS builds, but Docker dev container is functional for now.
   Multi-day PR. Sequence after Postgres adapter is at least partially
   working, to avoid stacking too much risky change.

## Quick-reference commands

```bash
# Switch to the branch
git checkout rename/dataform-to-sqlanvil

# View what changed
git diff restore-postgres-adapter..HEAD --stat | tail -5

# Build inside Docker (first run ~5 min, subsequent <1 min)
./scripts/docker-bazel build //protos:sqlanvil_proto

# Interactive shell inside the dev container
./scripts/docker-bazel

# When Node pin gets fixed in WORKSPACE, try:
./scripts/docker-bazel build //protos:ts
./scripts/docker-bazel build //core/...
./scripts/docker-bazel run //packages/@sqlanvil/cli:bin -- help
```

## Files worth re-reading first thing next session

- `docs/rename_checklist.md` — the original surface map
- `docs/postgres_first_class_design.md` — what comes after this rename
- `CLAUDE.md` — design directives + active-work context
- `Dockerfile.dev` + `scripts/docker-bazel` — verification workflow

## Memory state (in `~/.claude/projects/-Users-ivan-projects-ivan/memory/`)

- `user_dataform_expertise.md` — Ivan is experienced Dataform dev, skip 101
- `project_sqlanvil_postgres_design.md` — first-class Postgres + Supabase,
  nested config, rename mandatory, listanvil is target user
- `MEMORY.md` indexes them
