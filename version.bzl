# SQLANVIL_VERSION is the published @sqlanvil/* package version (sqlanvil's own
# SemVer line). DF_VERSION is the upstream dataform-co/dataform release this fork
# is synced to — surfaced as metadata (e.g. `sqlanvil --version`), not the package
# version. Bump SQLANVIL_VERSION for sqlanvil releases; bump DF_VERSION on upstream syncs.
SQLANVIL_VERSION = "1.30.0"
# 3.0.64 reviewed; taken selectively. Four upstream commits:
#
#   * #2228 protobufjs 7.6.3 -> 7.6.5. TAKEN (we were on 7.6.4 for the direct dep and 7.5.8 for
#     the `**/protobufjs` resolution; both now unify on 7.6.5, which also drops the
#     @protobufjs/inquire dynamic-require chain).
#
#   * #2235 lineage.enabled on WorkflowSettings/ProjectConfig. NOT TAKEN. It gates OpenLineage
#     emission to Google's Knowledge Catalog, read only by their hosted runner — inert in OSS —
#     and lineage is a standing won't-build for sqlanvil. It also could not be taken verbatim:
#     upstream assigns ProjectConfig.lineage_enabled = 25, which we already ship as
#     preserve_governance_controls (itself renumbered off upstream's 24; see the note above it),
#     and WorkflowSettings.lineage = 19, which we already ship as environments. Any future take
#     needs 26 / 21.
#
#   * #2211 "Integrate JiT compilation into CLI runtime". NOT TAKEN. This is the one that looks
#     like a straight merge and isn't. Its run.ts refactor drops the `withClientLock` wrapper
#     around an action's tasks and passes the adapter itself where a leased client was used.
#     That is free for upstream because BigQuery's withClientLock is `callback(this)` — a no-op
#     passthrough over a stateless REST API. Ours is not: the postgres and mysql executors lease
#     ONE pooled connection for the duration of an action, so every task in that action shares a
#     session. Taking the refactor would demote that to a fresh lease per statement and silently
#     break anything depending on session state across an action's tasks — temp tables,
#     SET/session GUCs, and transactions spanning pre_operations -> main -> post_operations.
#     Note this leaves sqlanvil exposing .jitCode()/jitData() (inherited from #2109/#2170/#2182)
#     with NO runtime that executes them: build.ts never copies jitCode onto the ExecutionAction
#     and run.ts has no JiT path. Closing that gap — either by wiring a JiT runtime written
#     against our leased-connection model, or by rejecting .jitCode() at compile time — is
#     tracked separately; it is not a merge of #2211.
#
#   * #2240 version bump only.
#
# Also taken, adapted: #2211 touches printExecutedActionErrors, which we shared a bug with —
# it indexed executionAction.tasks by the *filtered* failing-task position, so a failure after a
# passing pre_operation printed the wrong SQL. Upstream's `?.` only silences the crash; ours is
# fixed to index by true task position.
DF_VERSION = "3.0.64"
