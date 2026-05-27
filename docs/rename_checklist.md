# Rename Checklist: `dataform` → `sqlanvil`

**Status:** Draft / Spec
**Branch target:** `rename/dataform-to-sqlanvil` (first of three PRs per `postgres_first_class_design.md` §9)
**Driver:** Trademark risk from Google's "Dataform" product.

## Conventions

- **Package scope:** `@dataform/...` → `@sqlanvil/...` (keep scoped, just swap the scope owner).
- **Bazel workspace name:** `df` → `sa` (matches the existing 2-char convention). Implies tsconfig path `df/*` → `sa/*` and every import `from "df/core/..."` → `from "sa/core/..."`.
- **Proto package:** `dataform` → `sqlanvil`.
- **Proto Java package:** `com.dataform.protos` → `com.sqlanvil.protos` (cosmetic; no Java consumers in this fork).
- **Proto Go package:** `github.com/dataform-co/dataform/protos/dataform` → `github.com/ihistand/sqlanvil/protos/sqlanvil`.
- **Config file:** `dataform.json` is removed entirely (already deprecated upstream; clean break — no `sqlanvil.json` deprecated-fallback hybrid). `workflow_settings.yaml` is the only project config going forward; the key names are already neutral.
- **CLI binary:** `dataform` → `sqlanvil` (binary name and `./scripts/run` references).
- **NOT renamed (legitimate upstream references):** the git remote `upstream` pointing at `github.com/dataform-co/dataform`, attribution lines in LICENSE-equivalent files, historical commit messages.

## Categorized Checklist

### A. Proto schema (8 files)

```
protos/configs.proto
protos/core.proto
protos/db_adapter.proto
protos/evaluation.proto
protos/execution.proto
protos/extension.proto
protos/jit.proto
protos/profiles.proto
```

In each:

- [ ] `package dataform;` → `package sqlanvil;`
- [ ] `option java_package = "com.dataform.protos";` → `option java_package = "com.sqlanvil.protos";` (where present)
- [ ] `option go_package = "github.com/dataform-co/dataform/protos/dataform";` → `option go_package = "github.com/ihistand/sqlanvil/protos/sqlanvil";` (where present)
- [ ] Field-level: `string dataform_core_version` → `string sqlanvil_core_version` (in `configs.proto` line 18 and `core.proto` line 414). **This is a wire-format-breaking change** — fine, since we're publishing fresh.
- [ ] Comment-level: `// The desired dataform core version to compile against.` → `// The desired sqlanvil core version to compile against.`
- [ ] URL comments pointing at `cloud.google.com/dataform/docs/...` — **keep** if they reference legitimate BigQuery/Dataform partitioning docs that are still factually correct, OR replace with sqlanvil's own docs once written. For the rename PR, keep them — annotate them as TODO for the Postgres-first-class doc work.

### B. Bazel — WORKSPACE / BUILD / .bzl (every BUILD file)

- [ ] `WORKSPACE` line 1: `workspace(name = "df")` → `workspace(name = "sa")`
- [ ] `protos/BUILD:7,27`: target `dataform_proto` → `sqlanvil_proto` (and the `:dataform_proto` reference in same file)
- [ ] Directory rename: `packages/@dataform/` → `packages/@sqlanvil/` (rename `packages/@dataform/cli` → `packages/@sqlanvil/cli`, same for `core`)
- [ ] Every `//packages/@dataform/core:package_tar` label → `//packages/@sqlanvil/core:package_tar` (15+ occurrences across BUILD files in `core/`, `cli/`, `cli/api/`, `examples/`, and every `tests/**/BUILD`)
- [ ] Every `//packages/@dataform/cli:package_tar` label → `//packages/@sqlanvil/cli:package_tar` (3+ occurrences)
- [ ] `packages/@dataform/core/BUILD:47`: `package_name = "@dataform/core"` → `package_name = "@sqlanvil/core"`
- [ ] `packages/@dataform/cli/BUILD:56`: `package_name = "@dataform/cli"` → `package_name = "@sqlanvil/cli"`
- [ ] `packages/sample-extension/BUILD:46`: `package_name = "@dataform/sample-extension"` → `package_name = "@sqlanvil/sample-extension"`
- [ ] `//packages/@dataform:package.layer.json` → `//packages/@sqlanvil:package.layer.json` (and rename the directory layer file)
- [ ] `BUILD` (root) line 55: `# gazelle:prefix github.com/dataform-co/dataform` → `# gazelle:prefix github.com/ihistand/sqlanvil`
- [ ] `vscode/BUILD:46`: `dataform_logo.png` reference (and the actual file rename — see §G)
- [ ] `test_credentials/BUILD:12-14`: GCP KMS keyring references (`dataform-open-source`, `dataform-builder-key`, `dataform-builder-keyring`) — these point at `dataform-co`'s GCP project which Ivan can't access. **Delete or replace** with his own GCP KMS setup. For the rename PR: delete `test_credentials/BUILD` entirely; integration tests against BQ will need fresh credentials wiring anyway.

### C. tsconfig + TypeScript imports

- [ ] `tsconfig.json` `paths`: `"df/*"` → `"sa/*"` (and the three array entries underneath — same key)
- [ ] All TS imports across `core/`, `cli/`, `tests/`, `testing/`, `tools/`, `packages/` of the form `from "df/..."` → `from "sa/..."`. Mechanical sed:

```bash
find . -name '*.ts' -not -path '*/node_modules/*' -not -path './bazel-*' \
  -exec sed -i '' 's|from "df/|from "sa/|g; s|require("df/|require("sa/|g; s|import("df/|import("sa/|g' {} +
```

Estimated occurrences: hundreds. Verify after with `grep -r '"df/' --include='*.ts'` returns nothing outside generated bazel output.

### D. npm package metadata

- [ ] `package.json` (root): add `"name": "sqlanvil"` if absent (currently the file has no `name` field — confirms it's a workspace root, fine to leave nameless, but add `"private": true` + repo URL).
- [ ] Subdirectory `package.json` files for the published packages — generated from `tools/gen-package-json/` templates? Confirm whether the templates live there and update them. Otherwise update each:
  - `packages/@sqlanvil/cli/package.json` (post-directory-rename) — `"name": "@sqlanvil/cli"`, `"bin": { "sqlanvil": "..." }`
  - `packages/@sqlanvil/core/package.json` — `"name": "@sqlanvil/core"`
  - `packages/sample-extension/package.json` — `"name": "@sqlanvil/sample-extension"`
- [ ] `tests/integration/bigquery_project/package.json` — drop or update `@dataform/core` dependency to `@sqlanvil/core`.
- [ ] `tests/api/projects/common_v2/package.json` — same.
- [ ] `tests/api/projects/never_finishes_compiling/package.json` — same.
- [ ] `tests/api/projects/invalid_dataform_json/package.json` — see §F (test deletion).
- [ ] `vscode/package.json` — VSCode extension manifest. Rename: `name`, `displayName`, `publisher`, command IDs (`dataform.*` → `sqlanvil.*`), activation events.

### E. CLI binary + scripts

- [ ] `scripts/run`:
  ```bash
  bazel build //packages/@dataform/cli:bin       → //packages/@sqlanvil/cli:bin
  ./bazel-bin/packages/@dataform/cli/bin.sh "$@" → ./bazel-bin/packages/@sqlanvil/cli/bin.sh "$@"
  ```
- [ ] CLI binary `name` in `packages/@sqlanvil/cli/BUILD` — confirm the binary target name; rename anything `dataform_bin` / `dataform_cli` → `sqlanvil_bin` / `sqlanvil_cli`.
- [ ] `cli/yargswrapper.ts` / `cli/index.ts` `scriptName` calls (yargs program name shown in `--help`) — search for `.scriptName("dataform")` → `.scriptName("sqlanvil")`.
- [ ] Help text strings referencing "Dataform" → "sqlanvil".

### F. Drop the `dataform.json` legacy path

The upstream code already comments `dataform.json` as deprecated. Clean-break decision: remove it entirely instead of accepting a `sqlanvil.json` parallel.

- [ ] `cli/index.ts:59` — delete the `dataformJsonPath` resolution.
- [ ] `cli/vm/compile.ts:83` — delete `global.dataformJson = ...` line.
- [ ] `cli/api/commands/init.ts:26-27` — delete the dataform.json branch from project scaffolding.
- [ ] `core/workflow_settings.ts:15-20` — remove dataform.json fallback; `workflow_settings.yaml` is the only path.
- [ ] `testing/run_core.ts:113` — delete the dataformJson global injection.
- [ ] `core/main_test.ts` — delete tests at lines 545, 570, 606, 636, 803 (dataform.json validation tests). Keep the workflow_settings.yaml tests.
- [ ] `cli/index_compile_test.ts:47` — remove the dataform.json fixture usage from this test.
- [ ] Test fixture directory `tests/api/projects/invalid_dataform_json/` — delete entirely (its purpose was testing the legacy path).
- [ ] `tests/api/BUILD:9-10` — remove the `invalid_dataform_json` references.

### G. Static assets / branding

- [ ] `vscode/dataform_logo.png` → `vscode/sqlanvil_logo.png`. Replace the image asset itself before publishing the VSCode extension (Ivan needs to design/source one). For the rename PR, a placeholder is fine.
- [ ] `static/` directory — audit for any other branded assets (icons, banners).
- [ ] `LICENSE` — verify Apache-2.0 attribution is intact. Add a `NOTICE` file (Apache-2.0 §4 requirement when distributing derivative works): "sqlanvil is a derivative of Dataform, originally developed by Dataform Co and contributed to by Google LLC, licensed under Apache License 2.0." Required, not optional.

### H. Documentation

- [ ] `readme.md` (root) — currently empty per the `Dataform Core` indexed content (the README still has upstream's content). Rewrite for sqlanvil's positioning.
- [ ] `contributing.md` — update build/test instructions, replace `dataform` CLI references.
- [ ] `docs/configs-reference.md` — references `dataform` semantics. Update for sqlanvil and per the Postgres-first-class spec.
- [ ] `docs/packages.md` — package author guide; update `@dataform/...` patterns to `@sqlanvil/...`.
- [ ] `docs/reference/` — all existing reference docs (likely auto-generated; update generator templates rather than the output).
- [ ] `docs/postgres_reintegration_assessment.md` — mark "SUPERSEDED by postgres_first_class_design.md" at the top.
- [ ] `docs/hybrid_warehouses_supabase_bigquery.md` line 25 — `dataform.json` reference, update.
- [ ] `CLAUDE.md` — already names sqlanvil throughout; no change.

### I. Test credentials + CI

- [ ] `cloudbuild-publish.yaml`, `cloudbuild-test.yaml`, `cloudbuild-version.yaml` — these are upstream's Cloud Build configs targeting dataform-co's GCP project. Ivan can't run them. **Delete or replace** with GitHub Actions targeting his own infra. For the rename PR: delete.
- [ ] `test_credentials/bigquery.json` (referenced from `cli/BUILD` per contributing.md) — replace with Ivan's own GCP service account if he wants integration tests against a real BQ project; otherwise delete and remove the dependency from `cli/BUILD`.

### J. Code-level identifiers

- [ ] Class / interface / type names containing `Dataform`:
  - `IDataformConfig` (if exists) → `ISqlanvilConfig`
  - Any `DataformError`, `DataformProject`, etc. → `Sqlanvil...`
  - Grep: `grep -rn 'class.*Dataform\|interface.*Dataform\|type.*Dataform\|enum.*Dataform' --include='*.ts'`
- [ ] Variable names: `dataformJson`, `dataformCoreVersion`, etc. Search-and-replace where the meaning is unambiguous.
- [ ] String literals in error messages: `"Dataform compilation failed"` → `"sqlanvil compilation failed"`. Search: `grep -rn '"[^"]*Dataform[^"]*"' --include='*.ts'`.
- [ ] User-agent strings sent to BigQuery / external services — change so server-side logs distinguish sqlanvil from upstream Dataform.

### K. Repo metadata

- [ ] `.gitignore` — no dataform references expected, but verify.
- [ ] GitHub repo description (set via `gh repo edit ihistand/sqlanvil --description ...`).
- [ ] GitHub repo topics: drop `dataform`, add `sqlanvil`, `postgres`, `supabase`, `bigquery`, `data-pipeline`.

## Execution Order Within the Rename PR

1. **Mechanical first** (low-risk, high-volume): tsconfig + every `from "df/` → `from "sa/"` import, all `//packages/@dataform/` → `//packages/@sqlanvil/` Bazel labels, proto package names. Run `bazel build //...` and `bazel test //...` after each to catch breakage early.
2. **Directory moves**: `packages/@dataform/` → `packages/@sqlanvil/`, `vscode/dataform_logo.png` → `vscode/sqlanvil_logo.png`. Commit as separate logical step.
3. **Removals**: `dataform.json` code path (§F), Cloud Build configs, `test_credentials/BUILD` if not replaced.
4. **Identifiers and strings**: class/interface renames, error messages, help text.
5. **Docs + LICENSE NOTICE**.
6. **Final sweep**: `grep -ri 'dataform' . --include='*' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=bazel-*` — every remaining hit must be either (a) a legitimate upstream/attribution reference, (b) inside a comment URL pointing at cloud.google.com docs that's still factually valid, or (c) in this rename checklist itself.

## Verification Commands

After the rename PR is drafted, run all of these. Each must pass.

```bash
# 1. Build
bazel build //...

# 2. Test
bazel test //...

# 3. CLI smoke test
./scripts/run help
./scripts/run init /tmp/sqlanvil-test
ls /tmp/sqlanvil-test/   # should contain workflow_settings.yaml, NOT dataform.json

# 4. No stray references
grep -rn 'dataform' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=bazel-out \
  --exclude-dir=bazel-bin --exclude-dir=bazel-testlogs --exclude-dir=bazel-sqlanvil \
  | grep -v 'docs/rename_checklist.md' \
  | grep -v 'upstream' \
  | grep -v 'NOTICE' \
  | grep -v 'cloud.google.com/dataform'

# Expected: empty (or only allow-listed legitimate references)

# 5. No `df/` import paths remain
grep -rn '"df/' --include='*.ts' --exclude-dir=node_modules --exclude-dir='bazel-*' .
# Expected: empty
```

## Out of Scope (Defer to Later PRs)

- Postgres adapter implementation — that's PR 2 (`adapter/postgres-first-class`).
- Supabase variant — PR 3 (`adapter/supabase-variant`).
- New proto messages (`PostgresOptions`, `SupabaseOptions`, `WarehouseConfig`) — also PR 2.
- VSCode extension actual feature work — only the rename happens here.
- Marketing site (`sqlanvil-com/`) content rewrite — separate concern.

## Risk Notes

- **Upstream merges become harder after this PR.** Every cherry-pick from `upstream/main` will conflict on package names, imports, BUILD labels. Mitigation: pull all desired upstream changes first, merge cleanly, then start the rename.
- **The wire-format change to `dataform_core_version` → `sqlanvil_core_version`** means any compiled graph proto file from upstream Dataform won't deserialize. Acceptable since sqlanvil isn't claiming proto compatibility with upstream.
- **Bazel cache invalidates entirely** after directory moves. First post-rename build will be slow (cold cache).
