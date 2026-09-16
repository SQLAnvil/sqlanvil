# SQLANVIL_VERSION is the published @sqlanvil/* package version (sqlanvil's own
# SemVer line). DF_VERSION is the upstream dataform-co/dataform release this fork
# is synced to — surfaced as metadata (e.g. `sqlanvil --version`), not the package
# version. Bump SQLANVIL_VERSION for sqlanvil releases; bump DF_VERSION on upstream syncs.
SQLANVIL_VERSION = "1.32.5"
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
#     Reported upstream as #2267; fixed by #2273 (post-3.0.68, identical one-line clone +
#     view_test). Already carried here — expect a no-op when 3.0.69 is reviewed.
#
#   * #2259 / #2261 / #2262 / #2263 / #2264 OpenLineage emitter hardening (endpoint routing,
#     retry, structured errors, DATAFORM_LINEAGE_DEBUG, UNAUTHENTICATED skip, tests). NOT TAKEN —
#     all land in cli/api/lineage/, which does not exist here; lineage is a standing won't-build.
#
#   * #2265 version bump only.
#
# Nothing else in the release touches core/, cli/index.ts, run.ts, or the dbadapters.
# 3.0.68 reviewed; one commit taken. Four upstream commits:
#
#   * #2271 ref()/resolve() compilation errors blamed on "index.js". TAKEN, verbatim. Reproduced
#     here first: `SELECT 1 FROM ${ref("FOO")}` in definitions/mytable.sqlx produced a
#     CompilationError with fileName "index.js" (their regression test went red against our
#     tree before the fix). Session.resolve calls compileError() with no explicit path, so it
#     fell through to getCallerFile(); under vm2 >= 3.11.3 the sandbox strips CallSite file
#     paths, and our __sqlanvil_current_file getter (cli/vm/compile.ts) is a module-LOAD stack —
#     by the time an action's callback runs inside Session.compile() the sqlx module has already
#     exited, so the top of the stack is the index.js entry. Fix tracks the current action's file
#     on the Session around action.compile() in compileGraphChunk and lets compileError() prefer
#     it over the caller-file fallback. Explicit-path callers are unchanged.
#
#   * #2258 PropertyGraph ref()/DAG dependencies and #2268 PropertyGraph CLI/E2E coverage. NOT
#     TAKEN — PropertyGraph is a standing decline (BigQuery-only; proto field-number collisions,
#     see the 3.0.65 note). #2258's `Session.resolveTarget` extraction is a refactor of resolve()
#     that exists only to serve PropertyGraph.resolveRefIntoDataSource; nothing else calls it, so
#     it is not carried. #2268's prune.ts / graphs.ts / console.ts hunks are all propertyGraphs
#     plumbing. #2268's new prune_test.ts is PropertyGraph-shaped throughout; not taken either.
#
#   * #2276 version bump only.
#
# Nothing in the release touches core/actions/, cli/index.ts, run.ts, or the dbadapters. The
# view.ts shared-config gap noted under 3.0.67 (our #2267) is fixed upstream by #2273, which
# is after 3.0.68 and will show up in 3.0.69.
#
# Carried ahead of 3.0.69 (2026-09-06): Session.declare passed the caller's config object straight
# into Declaration, whose verifyConfig renames database/schema -> project/dataset and replaces
# `columns` with protos IN PLACE — so a shared sources object in includes/ read back
# `undefined.undefined.orders` after declare(). publish()/operate()/assert() already spread theirs.
# Reported upstream as #2280; fixed by #2283 (shallow-clone in declare() + declaration_test).
# Same clone applied here at the top of declare() so the connection (FDW / runner-extract) paths
# keep reading the caller's untouched object; the two "constructor MUTATES config" comments in
# those paths are gone. Test taken verbatim (red here before the fix). Expect a no-op when
# 3.0.69 is reviewed.
#
# 3.0.69 reviewed (2026-09-07); one commit taken. Six upstream commits:
#
#   * #2273 View.verifyConfig shallow-clones `bigquery` before its hoist-then-delete loop.
#     ALREADY HERE — this is upstream's fix for our #2267, carried under 3.0.67 (same one-line
#     clone in view.ts, same test "a shared config object can be reused across publish()
#     calls without losing fields"). No-op.
#
#   * #2283 Session.declare shallow-clones its config. ALREADY HERE — carried ahead on
#     2026-09-06 (see above); our clone sits at the top of declare() so both Declaration call
#     sites and the connection paths share it. Upstream's declaration_test is the one we took
#     verbatim. No-op.
#
#   * #2163 dependabot: fast-xml-parser 5.5.6 -> 5.7.3 (transitive, via @google-cloud/storage).
#     TAKEN. Our yarn.lock had diverged (fast-xml-builder 1.1.4, no path-expression-matcher
#     ^1.5.0 / xml-naming), so the hunk didn't apply; the four replaced entries and three new
#     ones (@nodable/entities, anynum, xml-naming) were lifted from 3.0.69's lockfile instead
#     and verified with `yarn install --frozen-lockfile` under Bazel's yarn 1.13. Dev-tree
#     hygiene only: nothing in core/ or cli/ imports @google-cloud/storage and it is not in
#     either published package layer.
#
#   * #2275 tags on PropertyGraph actions and #2281 includeDependentAssertions=false on
#     PropertyGraph refs. NOT TAKEN — PropertyGraph is a standing decline (BigQuery-only; proto
#     field-number collisions, see the 3.0.65 note); core/actions/property_graph.ts does not
#     exist here. #2275's prune.ts hunk drops the `"tags" in action` guard purely so
#     propertyGraphs pass through; not carried.
#
#   * #2284 version bump only.
#
# Nothing else in the release touches core/, cli/index.ts, run.ts, or the dbadapters.
#
# Carried ahead of 3.0.70 (2026-09-08): upstream #2286 decomposes the monolithic cli/index.ts
# into cli/commands/<name>_command.ts + cli/common_options.ts + cli/project_config_options.ts,
# with index.ts only registering commands. Pure refactor, no behaviour change. Could NOT be
# applied as a patch — our index.ts had 15 commands to upstream's 9 and ~1,100 divergent lines —
# so the same split was redone by hand on our file, mirroring upstream's layout and file names
# so future upstream CLI commits land against matching files. Deviations from upstream's cut:
# the selection flags (actions/tags/include-*) and credentials/json/timeout/quiet/no-artifacts
# live in common_options.ts because validate/run/compile/format share them here (upstream keeps
# most of them private to run_command.ts); the environment helpers
# (projectConfigOverrideWithEnvironment, credentialsPathWithEnvironment) sit alongside; the
# artifact commands share cli/commands/artifact_views.ts; runValidate is exported from
# validate_command.ts for run --dry-run. Exported option consts gained explicit
# INamedOption<yargs.Options, "<flag>"> annotations (Bazel's declaration emit rejects the
# inferred yargs types — TS2742). Verified: `help` output for all 15 commands is byte-identical
# to the published 1.32.4 CLI; all //cli tests pass (incl. compile + run_e2e); smoke project
# compile/query/inspect/docs/run --dry-run behave identically. When 3.0.70 is reviewed, expect
# #2286 to be a no-op and later cli/commands/* commits to apply with path-only fuzz.
#
# Carried from an UNMERGED upstream PR (2026-09-08): #1846 (open since 2024-09) — a numeric
# `defaultProject`/`defaultDataset` in workflow_settings.yaml crashed much later in the proto
# encoder ("The \"string\" argument must be of type string ... Received type number"). Reproduced
# here first. Taken in spirit, not verbatim: upstream checks `typeof !== "string"` inside
# Session.compile(), which would also reject an ABSENT value; ours sits in
# workflowSettingsAsProjectConfig, fires only when the key is present and not a string, and
# names the YAML key ("Workflow settings error: defaultDataset must be a string (got 12345)").
# Both upstream tests adapted into core/main_test.ts. If #1846 ever merges, expect a conflict
# in session.ts to resolve by keeping ours.
#
# Reviewed ahead of 3.0.70 (2026-09-16):
#
#   * #2299 dependabot: js-yaml 4.3.0 -> 4.3.2. TAKEN. Not dev-tree hygiene this time:
#     @sqlanvil/core bundles js-yaml from our yarn.lock (external_deps = []), so published core
#     1.32.5 ships 4.3.0, which is open to two HIGH CPU-exhaustion advisories on untrusted YAML —
#     GHSA-5p4m-2wfm-xmqj (!!omap, fixed 4.3.1) and GHSA-2883-xcg3-v3hh (empty merge sources slip
#     past maxTotalMergeKeys, fixed 4.3.2). core parses workflow_settings.yaml / actions.yaml, and
#     the Cloud runner compiles customer repos with it. The package.json hunk applied; the yarn.lock
#     hunk didn't (its strip-ansi re-split doesn't match our lockfile), so only the js-yaml entry
#     was lifted. Verified: `bazel run @nodejs//:yarn install -- --frozen-lockfile`; //core/... and
#     //cli/api/... pass; the rebuilt core bundle contains 4.3.2's "abnormal merge sequence size"
#     guard (absent from the published 1.32.5 bundle). The CLI already takes js-yaml as an external
#     `^4.2.0` range, so fresh CLI installs resolved 4.3.2 regardless.
#
#   * #2313 removes typedoc + typedoc-plugin-markdown from package.json (Dependabot alert on the
#     marked@1.0.0 they pin) and has scripts/regenerate_docs fetch them on the fly with
#     `npx --yes -p typedoc@0.17.8 -p typedoc-plugin-markdown@2.2.17 typedoc`. DECLINED. Upstream
#     treats its reference docs as frozen; ours regenerate on every release (reference pages for
#     sqlanvil-docs and sqlanvil-com). The npx form is broken: typedoc 0.17.8 only peers on
#     `typescript >=3.8.3`, so npx installs TypeScript 7.0.2 beside it and typedoc crashes on load
#     ("Cannot read properties of undefined (reading 'ClassDeclaration')"); adding
#     `-p typescript@3.8.3` didn't change what npx resolved. It only appears to work from our repo
#     root because the local typedoc is still installed. No runtime exposure to decline: typedoc is
#     dev-only, not in either published package or the Bazel build, and only reads our own doc
#     comments. If an alert ever needs clearing, move typedoc + a pinned typescript@3.8.3 into
#     tools/typedoc/package.json beside postprocess.py rather than taking this. At the 3.0.70 sync,
#     resolve package.json / yarn.lock conflicts around typedoc by keeping ours.
DF_VERSION = "3.0.69"
