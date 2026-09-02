# SQLANVIL_VERSION is the published @sqlanvil/* package version (sqlanvil's own
# SemVer line). DF_VERSION is the upstream dataform-co/dataform release this fork
# is synced to — surfaced as metadata (e.g. `sqlanvil --version`), not the package
# version. Bump SQLANVIL_VERSION for sqlanvil releases; bump DF_VERSION on upstream syncs.
SQLANVIL_VERSION = "1.32.1"
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
#     other than BigQuery grows SQL/PGQ. (3.0.66 wired it — see below — the second condition
#     still doesn't hold.)
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
# change to conflict. When taking any future run.ts / cli index.ts change, preserve our
# `--timeout` semantics: it is COMPILE-ONLY here (all four commands pass it solely to
# compile(); the run command's RunConfig never carries timeoutMillis). #2211 silently
# redefined it upstream as a whole-command deadline that cancels in-flight work with no
# message — reported as upstream issue #2247 ("breaking existing runs without any error
# output"). Do not import that redefinition.
#
# 3.0.66 reviewed; four commits taken, one of them partially. Ten upstream commits:
#
#   * #2236 incremental table + metadata.extraProperties. TAKEN, adapted. Reproduced here first:
#     `type: "incremental", onSchemaChange: "IGNORE", metadata: { extraProperties: {...} }` failed
#     with `Unexpected property "priority"` (a plain `table` with the same block compiled fine).
#     protobufjs's verify() returns at its FIRST error — the enum-as-string — so the nested
#     Struct never got normalized. Upstream replaced its verify() call with fromObject(); we KEEP
#     our verify() call (it backs the object-in-scalar-field guard, see common/protos/index.ts)
#     and add the fromObject() normalization pass after it, plus a Struct.fromObject monkey-patch
#     mirroring Struct.verify. Their view/assertion tests taken verbatim; the incremental one
#     rewritten against our expected shape.
#
#   * #2252 `--dot` emitted `"x" [label="x";` for operations (missing `]`). TAKEN — reproduced.
#
#   * #2245 vm2 3.11.4 -> 3.11.6. TAKEN.
#
#   * #2256 "Restore --timeout as compile-only; add --execution-timeout" — upstream's fix for our
#     issue #2247. TAKEN in part. The *restore* is a no-op here: --timeout never changed. Taken:
#     `run --execution-timeout` (wired to RunConfig.timeoutMillis, which Runner already honoured
#     but nothing set), the top-level "Run timed out / Run cancelled." stderr line so exit 1 is
#     never silent, and the `(reason)` suffix on per-action SKIPPED lines. NOT taken: the
#     "--timeout only bounds compilation" advisory (there was no semantics change to warn about
#     here) and the JiT-timeout wording.
#
#   * #2251 / #2253 / #2255 PropertyGraph wired into compile, build and DDL execution. NOT TAKEN.
#     This trips the "lands wired" half of the 3.0.65 revisit condition, but not the other half:
#     SQL/PGQ is still BigQuery-only, and the field-number collisions (ActionConfig 9,
#     CompiledGraph 16) are unchanged. Still declined.
#
#   * #2248 / #2254 OpenLineage RunEvents to Knowledge Catalog Lineage (new cli/api/lineage/,
#     ~1,500 lines incl. tests, GCP-only sink). NOT TAKEN — lineage is a standing won't-build.
#
#   * #2257 version bump only.
#
# JiT — DECIDED (3.0.65): sqlanvil does not build a JiT runtime, and JiT commits stay declined as
# a standing policy rather than a per-release judgement call. The open question from the 3.0.64
# note ("wire a runtime, or reject at compile time") is resolved in favour of rejecting — and the
# guard is already in place: rejectJitCompilation (core/utils.ts, landed in 1.30.0) throws at
# compile time from .jitCode() on all five action classes and from jitData(), with the error
# attributed to the right file/target by Session.compile(). Tested in the per-action tests and
# main_test.ts. Nothing mechanical remains; future JiT upstream commits are declined on sight.
# 3.0.67 reviewed; one commit taken, extended. Seven upstream commits:
#
#   * #2260 LegacyConfigConverter mutated caller-shared configs. TAKEN, and extended. A JS
#     `const shared = {type: "table", bigquery: {...}, assertions: {...}}` reused across
#     `publish("t1", shared); publish("t2", shared)` left t2/t3 with an EMPTY bigquery block:
#     Session.publish spreads the config into a fresh top-level object per call, but the nested
#     `bigquery` / `assertions` objects stay shared, and the converter's hoist-then-delete loop
#     stripped them on the first pass. Regression from upstream #1780 (3.0.10) — present here
#     too. Upstream's fix (shallow-clone both nested objects before mutating) applied cleanly,
#     test taken verbatim. EXTENDED: upstream missed core/actions/view.ts, which has its own
#     hoist-then-delete loop over `bigquery` (labels/additionalOptions/partitionBy/clusterBy)
#     outside the converter, so a shared materialized-view config still lost its partitioning
#     on the second publish. Same one-line clone added there, with a mirrored view test.
#     Not reported upstream yet (see below).
#
#   * #2259 / #2261 / #2262 / #2263 / #2264 OpenLineage emitter hardening (endpoint routing,
#     retry, structured errors, DATAFORM_LINEAGE_DEBUG, UNAUTHENTICATED skip, tests). NOT TAKEN —
#     all land in cli/api/lineage/, which does not exist here; lineage is a standing won't-build.
#
#   * #2265 version bump only.
#
# Nothing else in the release touches core/, cli/index.ts, run.ts, or the dbadapters.
DF_VERSION = "3.0.67"
