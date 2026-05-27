# Branch Strategy

**Status:** Reference / runbook
**Audience:** Ivan + future contributors
**Last updated:** 2026-05-27

## 0. TL;DR

- `main` is sqlanvil's source of truth. Not pristine upstream — already
  diverged from `dataform-co/dataform/main` in 2026 with the Postgres
  adapter restore + Antigravity docs.
- `upstream-main` (to be created) will mirror
  `dataform-co/dataform/main` for occasional cherry-picks if upstream
  ever ships something worth pulling.
- Long-lived branches: `main`, `restore-postgres-adapter` (active
  integration), `upstream-main` (future).
- Short-lived: PR feature branches per the existing stack pattern
  (`rename/...`, `adapter/...`, `fix/...`, `ci/...`, `docs/...`).
- Protect `main` against force-push + deletion. Skip required reviews
  (solo dev) + status checks (no CI yet) for now.

## 1. State Today

```
upstream/main  (github.com/dataform-co/dataform)
       │
       │  fork point — somewhere in 2024
       ▼
main           ← already has 3 Ivan commits (postgres restore + 2 doc PRs)
       │
       ▼
restore-postgres-adapter   ← active integration branch
       │
       ├── rename/dataform-to-sqlanvil           (PR #1)
       ├── fix/node-toolchain-pin                (PR #2 → base #1)
       ├── fix/rules-docker-decl                 (PR #3 → base #2)
       ├── adapter/postgres-deps                 (PR #4 → base #3)
       ├── adapter/postgres-relocate             (PR #5 → base #4)
       ├── adapter/postgres-proto-additions      (PR #6 → base #5)
       ├── adapter/postgres-skeleton             (PR #7 → base #6)
       ├── ci/bq-test-creds-env                  (PR #9 → base #7)
       └── docs/site-plan                        (PR #8 → base
                                                  restore-postgres-adapter)
```

`main` is **not** upstream-tracking even today. It already has work on
it. So the choice is not "preserve pristine upstream tracking" but
"how do we keep the option of upstream sync alive while making `main`
the sqlanvil source of truth."

## 2. Two Possible Paths

### Path A — Recommended (simpler)

**Keep `main` as sqlanvil's main. Add `upstream-main` mirror for
cherry-picks.**

```bash
# One-time, after PR #1-#7 merge into restore-postgres-adapter:
git checkout main
git merge --no-ff restore-postgres-adapter
git push origin main

# Then maintain an upstream tracking branch:
git checkout -b upstream-main upstream/main
git push -u origin upstream-main
```

Ongoing:

- `main` = sqlanvil source of truth. Default clone target. CLI built
  from here.
- `upstream-main` = mirror of `dataform-co/dataform/main`. Update
  periodically:
  ```bash
  git fetch upstream
  git push origin upstream/main:upstream-main
  ```
- Cherry-pick from `upstream-main` when something is worth pulling:
  ```bash
  git cherry-pick <sha>
  ```
- Default branch on GitHub stays `main`.

**Pros:** Conventional. Clones do the right thing. Zero rename
overhead. PRs stay where they are.
**Cons:** None significant.

### Path B — Alternative (renaming)

**Rename `main` → `dataform-upstream`. Promote work to a new `main`.**

```bash
git branch -m main dataform-upstream
git push origin :main dataform-upstream
git push origin -u dataform-upstream

git checkout restore-postgres-adapter
git branch -m restore-postgres-adapter main
git push origin -u main

# GitHub UI: change default branch dataform-upstream → main
```

**Pros:** Cleaner semantics — `main` only has sqlanvil work.
**Cons:** Loses commits already on `main` (postgres restore + doc PRs
would need cherry-picking). Confuses tooling that assumes `main` is
the fork point. Requires retargeting the 9 open PRs.

## 3. Recommendation

**Path A.** Reasons:

- `main` already has sqlanvil-side work — no point preserving the
  pre-restore state as "upstream tracking."
- Path A is one merge commit + one new branch. Path B is rename +
  GitHub default-branch swap + retarget 9 PRs.
- Stack already chains to `restore-postgres-adapter` → eventually
  `main`. Path A: PRs cascade naturally. Path B: have to retarget.

## 4. Recommended Timing

**Do the consolidation after the PR stack lands. Not now.**

Order of operations:

1. Merge PRs #1-#7 each into `restore-postgres-adapter` in sequence.
   Each PR is small + reviewable as a unit.
2. Merge `restore-postgres-adapter` into `main`:
   ```bash
   git checkout main
   git merge --no-ff restore-postgres-adapter
   git push origin main
   ```
3. Delete merged PR branches (`gh pr close` does this on merge, or
   `git push origin --delete <branch>`).
4. Create `upstream-main` mirror **once**, for future cherry-picks:
   ```bash
   git checkout -b upstream-main upstream/main
   git push -u origin upstream-main
   ```
5. New PRs target `main` from then on. `restore-postgres-adapter` can
   stay as a long-lived integration branch for grouping related work,
   or be retired in favor of feature branches off `main`.

## 5. Branch Protection

Apply to `main` (and `restore-postgres-adapter` if it stays
long-lived):

| Protection | Enable? |
| :--- | :--- |
| Block force push | ✅ |
| Block deletion | ✅ |
| Require linear history | ⚪ optional taste preference |
| Require PR before merging | ❌ solo dev, would self-bypass |
| Require status checks | ❌ no CI yet — add when CI lands |
| Require code review approvals | ❌ solo dev |
| Restrict who can push | ❌ solo dev |
| Require signed commits | ⚪ if you've set up GPG/SSH signing |

GitHub UI path: Settings → Branches → "Add branch protection rule"
→ `main` → check the two top boxes.

When CI lands (post-PR #9 GCP setup), add required status checks:
`bq-integration`, future `bazel-build`.

## 6. Upstream Sync Cadence

Upstream `dataform-co/dataform` has very low activity since Google's
focus shifted to BQ-hosted Dataform. Realistic expectation: you may
never merge from upstream again.

Schedule for keeping `upstream-main` warm:

- **Pull upstream once a quarter** — low effort, just `git fetch
  upstream && git push origin upstream/main:upstream-main`.
- **Skim the diff** for anything worth cherry-picking (bug fixes,
  security patches, BigQuery API updates that we still rely on).
- **Most of the time:** nothing to pull. Move on.

Don't bother subscribing to upstream releases or watching the repo —
the signal-to-noise ratio is too low for the volume.

## 7. PR Branch Naming Conventions

Already established in the current stack:

| Prefix | Use case |
| :--- | :--- |
| `rename/...` | One-time mechanical renames |
| `adapter/postgres-*` | Postgres-first-class adapter work |
| `adapter/supabase-*` | Future Supabase variant work |
| `fix/...` | Bug fixes, dep refreshes, toolchain repairs |
| `ci/...` | CI infra, test creds, GCP setup |
| `docs/...` | Documentation, plans, runbooks |
| `feat/...` | New features (use sparingly — most work fits above) |

Keep PRs small. Stack on top of each other rather than bundling. The
current 9-PR stack is the model.

## 8. References

- `docs/rename_handoff.md` — earlier handoff from the rename PR
- `docs/postgres_first_class_design.md` §9 — original 3-PR plan that
  expanded into the current 9-PR stack
- `docs/docs_site_plan.md` — independent doc site plan
- `docs/gcp_test_project_setup.md` — BQ test creds runbook
- [GitHub branch protection docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

## 9. Action Items

When ready to consolidate:

- [ ] Merge PRs #1 → #7 in order into `restore-postgres-adapter`
- [ ] Apply branch protection (force-push + deletion) to `main` now
- [ ] After stack lands: `git checkout main && git merge --no-ff
      restore-postgres-adapter && git push`
- [ ] Create `upstream-main` mirror branch
- [ ] Delete merged PR branches
- [ ] Update branch protection if `restore-postgres-adapter` retired
