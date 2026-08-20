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
#
# 3.0.65 reviewed; one commit taken. Six upstream commits:
#
#   * #2227 `format --ignore-js-files`. TAKEN (adapted to our inline `option(...)` idiom rather
#     than upstream's INamedOption const). Restricts the default formatter glob to `*.sqlx`, which
#     matters more here than upstream — sqlanvil projects lean on `includes/*.js`.
#
#   * #2243 / #2246 / #2249 PropertyGraph (proto surface, action class, review follow-up).
#     NOT TAKEN. Two hard field-number collisions: upstream assigns ActionConfig.property_graph = 9
#     (we ship rls_policy = 9; next free is 16) and CompiledGraph.property_graphs = 16 (we ship
#     `repeated Import imports = 16`; next free is 19). Renumbering isn't worth it: SQL/PGQ property
#     graphs are BigQuery-only with no Postgres or MySQL equivalent, so it would be dead weight in
#     three of four adapters. And upstream hasn't finished it — at tag 3.0.65 nothing in
#     session.ts / actions/index.ts / main.ts / build.ts / run.ts constructs a PropertyGraph, so
#     it is unreachable from a project. Revisit only if it lands wired AND a target warehouse
#     other than BigQuery grows SQL/PGQ.
#
#   * #2223 "Wire assertion actions into the JiT compilation runtime" and #2185 "JiT test suite".
#     NOT TAKEN — both are downstream of #2211, declined above; there is no JiT runtime here to
#     wire into (no `jit` reference exists in run.ts, cli/index.ts, or the dbadapters). Note
#     protos/jit.proto is UNCHANGED in 3.0.65 and we already carry
#     JIT_COMPILATION_TARGET_TYPE_ASSERTION = 4 and JitAssertionResult, so proto parity costs
#     nothing and there is no numbering debt to pay later.
#
#     3.0.65 also finishes what #2211 started: it DELETES withClientLock from the IDbAdapter
#     interface (cli/api/dbadapters/index.ts) and from the BigQuery adapter, and strips the
#     corresponding stubs from tests/api/api.spec.ts. Explicitly NOT TAKEN — that is free upstream
#     (theirs was `callback(this)`) but we have six real implementation sites (postgres.ts,
#     mysql.ts, utils/postgres.ts, utils/mysql.ts, the interface, and bigquery.ts) and run.ts
#     leases one pooled connection per action through it. See the note at core/utils.ts:331.
#
#   * #2250 version bump only.
#
# Divergence watch: upstream's Runner has now moved far enough that their own tests call
# `Runner.resume(...)`, a static factory we do not have. Expect every future upstream run.ts
# change to conflict.
#
# JiT — DECIDED (3.0.65): sqlanvil does not build a JiT runtime, and JiT commits stay declined as
# a standing policy rather than a per-release judgement call. The open question from the 3.0.64
# note ("wire a runtime, or reject at compile time") is resolved in favour of rejecting. What
# remains is mechanical: .jitCode()/.jitData() are still exposed with nothing behind them, so they
# should be rejected at COMPILE time so a user cannot reach a dead path. Until that guard lands,
# calling .jitCode() compiles cleanly and then silently does nothing at run time.
DF_VERSION = "3.0.65"
