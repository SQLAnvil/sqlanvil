# SQLANVIL_VERSION is the published @sqlanvil/* package version (sqlanvil's own
# SemVer line). DF_VERSION is the upstream dataform-co/dataform release this fork
# is synced to — surfaced as metadata (e.g. `sqlanvil --version`), not the package
# version. Bump SQLANVIL_VERSION for sqlanvil releases; bump DF_VERSION on upstream syncs.
SQLANVIL_VERSION = "1.29.1"
# 3.0.63 was reviewed and deliberately not merged. Its only two commits were a version bump
# (PR #2237, titled "Publishing Dataform security patches" but containing no security change —
# one line of version.bzl) and compile node selection (PR #2212), which sqlanvil already shipped
# in ab5c0392 on 2026-06-16, seven weeks earlier and with the same design. The one thing worth
# taking was a prune() omission we shared: `targets` was not filtered alongside the action lists.
# Written against our own action set rather than cherry-picked, since prune.ts has diverged.
DF_VERSION = "3.0.63"
