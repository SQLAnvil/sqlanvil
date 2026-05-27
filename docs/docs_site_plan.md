# sqlanvil Docs Site — Sourcing & Build Plan

**Status:** Draft
**Owner:** Ivan
**Last updated:** 2026-05-27
**Related:**
- [`postgres_first_class_design.md`](postgres_first_class_design.md) — what the docs need to describe
- [`hybrid_warehouses_supabase_bigquery.md`](hybrid_warehouses_supabase_bigquery.md) — already-drafted reference doc
- Root [`NOTICE`](../NOTICE) — Apache 2.0 attribution already wired up for the code; will extend to docs

## 0. TL;DR

Pull the upstream OSS Dataform repo's `docs/` (Apache 2.0, already
inherited via fork) as the foundation. Fill the gaps from
`docs.cloud.google.com/dataform` (CC BY 4.0). Rewrite all BigQuery
examples as Postgres-native per the postgres-first-class design. Ship a
docs site at `docs.sqlanvil.com` (Vercel static) — markdown-driven.

## 1. Source Hierarchy

### Tier 1 — Apache 2.0 markdown source (preferred)

Already in upstream `dataform-co/dataform` repo at `docs/`:

```
docs/configs-reference.md
docs/packages.md
docs/reference/assertion.md
docs/reference/configs.md
docs/reference/declaration.md
docs/reference/incrementaltable.md
docs/reference/notebook.md
docs/reference/operation.md
docs/reference/session.md
docs/reference/table.md
docs/reference/test.md
docs/reference/view.md
```

- License: **Apache 2.0** (matches code license + existing NOTICE)
- Already inherited via fork
- Markdown source — easier to `git merge upstream/main -- docs/`
- Code samples already in code blocks (not embedded HTML)

### Tier 2 — Google Cloud web docs (CC BY 4.0)

`docs.cloud.google.com/dataform/docs/*` — for content that doesn't ship
in the OSS repo:

- Quickstart / getting-started walkthrough
- CLI reference (full flag tables)
- Troubleshooting guide
- Locations / quotas / billing pages (sqlanvil-irrelevant — skip)
- Release notes (sqlanvil writes its own)
- Tutorial walkthroughs

Footer of every page says:
> "Except as otherwise noted, the content of this page is licensed
> under the [Creative Commons Attribution 4.0 License](https://creativecommons.org/licenses/by/4.0/),
> and code samples are licensed under the Apache 2.0 License"

### Tier 3 — Do not pull

- `cloud.google.com/dataform/*` (marketing pages — different terms, not
  CC BY 4.0)
- GCP console screenshots (Google trademark + UI copyright)
- Anything behind login (TOS may restrict redistribution)
- Google's internal repos (not public anyway)

## 2. License Compliance

### Apache 2.0 (Tier 1 source)

Already handled by root `NOTICE`. When pulling docs:

1. Preserve copyright notices from any code samples.
2. Add a `NOTICE` entry for the docs in the root NOTICE:
   ```
   This product includes documentation adapted from Google's Dataform
   open source project (https://github.com/dataform-co/dataform),
   licensed under the Apache License 2.0. See:
   https://github.com/dataform-co/dataform/blob/main/LICENSE
   ```

### CC BY 4.0 (Tier 2 source)

Per page or per-section attribution. Recommended placement:

- At the bottom of each pulled page:
  ```
  ---
  Adapted from Google Cloud Dataform documentation
  (<source URL>), licensed under CC BY 4.0. Modifications by sqlanvil
  contributors to target PostgreSQL / Supabase semantics.
  ```
- In `docs/ATTRIBUTIONS.md`: line-item table of every pulled page,
  source URL, snapshot date.

### Trademark scrubbing (separate from copyright)

Even with permissive license:
- `Dataform` → `sqlanvil` (entire word mark)
- Remove Google Cloud logos
- Replace GCP console screenshots
- No "Powered by Google" / no implied endorsement (CC BY 4.0 §3(a)(1)(iii))

This is the same playbook as the code rename (PR #1).

## 3. Doc Pages by Phase

### Phase D1 — Pull Tier 1 source

Tickets:
- D1.1 — Copy `upstream/main:docs/` into `sqlanvil/docs/reference/`
  (some already there — diff first, keep best)
- D1.2 — Rename surface sweep on docs: `dataform` → `sqlanvil`,
  `@dataform/` → `@sqlanvil/`, `.df-credentials.json` → `.sa-credentials.json`
- D1.3 — Add `NOTICE` paragraph for inherited docs
- D1.4 — Verify nothing references BQ-only types/concepts unguarded
  (cluster_by, NOT ENFORCED PKs, OPTIONS, MERGE)

**Output:** every reference page exists, sqlanvil-branded, BQ-only
language flagged for D2 rewrite.

### Phase D2 — Postgres-first reference rewrites

For each action type, rewrite to be Postgres-first:

| Page | BigQuery section to gate | Postgres section to add |
|---|---|---|
| `reference/table.md` | partition_by/cluster_by/OPTIONS | `PartitionConfig` (RANGE/LIST/HASH), indexes, tablespace, fillfactor |
| `reference/view.md` | (mostly portable) | Just rebrand |
| `reference/incrementaltable.md` | MERGE-based upsert | `INSERT ... ON CONFLICT (...) DO UPDATE` |
| `reference/operation.md` | (mostly portable) | Rebrand + transaction semantics note |
| `reference/assertion.md` | (mostly portable) | Add note: assertions can compile to CHECK constraints when user opts in |
| `reference/declaration.md` | (mostly portable) | Rebrand |
| `reference/test.md` | (mostly portable) | Rebrand |
| `reference/notebook.md` | GCP-specific — **drop** | Skip — no sqlanvil equivalent |
| `reference/session.md` | (mostly portable) | Rebrand |
| `configs-reference.md` | regenerate from new proto | New: `PostgresOptions`, `SupabaseOptions`, `WarehouseConfig` |

**Output:** every page has Postgres-first content. BQ content gated
under explicit "BigQuery only" callouts.

### Phase D3 — Supabase-specific pages (original content)

No upstream source. Write from scratch:

- `reference/rls_policy.md` — RLS policies as action types
- `reference/realtime_publication.md` — Realtime publications
- `reference/wrapper.md` — Supabase Wrappers (FDW)
- `reference/vector_index.md` — pgvector convenience action

Plus concept pages:
- `concepts/supabase_target.md` — why Supabase is first-class
- `concepts/postgres_vs_bigquery.md` — BQ-isms that don't apply in PG
  (companion to `postgres_first_class_design.md` §4 table)

### Phase D4 — Top-of-funnel docs (CC BY 4.0 adaptation)

Pull structure from `docs.cloud.google.com/dataform`, rewrite content:

- `quickstart.md` — adapted from Google's quickstart; Postgres example
  project instead of BQ
- `cli/reference.md` — CLI flag reference (table format from Google's
  CLI ref page; sqlanvil flag values)
- `troubleshooting.md` — common errors (sqlanvil-specific; adapt
  problem structure from Google's troubleshooting page)
- `installation.md` — npm install + docker dev container (original)

### Phase D5 — Architecture & concepts (original)

Already drafted:
- `hybrid_warehouses_supabase_bigquery.md` → publish as
  `concepts/hybrid_warehouses.md`

To draft:
- `concepts/why_sqlanvil.md` — positioning vs upstream Dataform OSS,
  vs dbt, vs raw migrations
- `concepts/action_graph.md` — how actions form a DAG
- `concepts/incremental_strategies.md` — `ON CONFLICT` vs full reload
  vs CDC-style append
- `architecture.md` — adapter / SQL generator / CLI layout

## 4. Docs Site Build

### Stack

- **Source:** Markdown in `sqlanvil/docs/`
- **Site generator:** Pick between:
  - **Astro Starlight** — TypeScript-friendly, modern, MDX support,
    great search. Recommended.
  - **Docusaurus** — React-based, more featureful, heavier.
  - **VitePress** — Vue-based, lighter than Docusaurus.
  - **mdBook** — Rust-based, very fast, simpler.
  - **Plain Vercel + remark** — minimal, full control.
- **Host:** Vercel project `docs-sqlanvil-com`, domain `docs.sqlanvil.com`
- **Repo:** Sibling repo `../sqlanvil-docs/` (separate from monolith
  `sqlanvil/` so docs deploys don't trigger code CI)

### CI

- GitHub Action on PR: build site, deploy preview URL
- Main branch → production
- Markdown lint + link check on every PR

### Search

- Algolia DocSearch (free for open source)
- Alternative: client-side Pagefind (Astro Starlight default)

## 5. Sequencing vs Code PRs

Doc work can happen in parallel with code Phases 3b-5 but should not
block them. Ordering:

| Code phase | Doc work that depends on it |
|---|---|
| Phase 3a (adapter) | D2 — references that mention adapter methods |
| Phase 3b (SQL gen) | D2 — every action-type page's "compiled output" examples |
| Phase 4 (CLI wiring) | D4 — CLI reference, quickstart |
| Phase 5 (Supabase) | D3 — Supabase action type pages |

Phase D1 + D5 can happen anytime — no code dependency.

## 6. Open Questions

- **Doc versioning.** If sqlanvil ships v0.x and breaking changes are
  likely, do we version the docs? Defer until v1.0; for now,
  `latest` only.
- **Hosting cost.** Vercel free tier easily handles a docs site. Algolia
  DocSearch is free for OSS. Total cost: $0/mo at sqlanvil's scale.
- **Search index update cadence.** Tied to Vercel deploys — no separate
  trigger.

## 7. Action Items (immediate)

- [ ] Decide site generator (recommend Astro Starlight)
- [ ] Create sibling repo `../sqlanvil-docs/`
- [ ] Wire Vercel project + domain `docs.sqlanvil.com`
- [ ] Phase D1.1: copy `upstream/main:docs/` into the new repo
- [ ] Add `NOTICE` paragraph + `ATTRIBUTIONS.md`
- [ ] First-pass rename sweep on inherited content

Phase D1 is mostly mechanical — should fit in a single afternoon.
Subsequent phases scale with code maturity.
