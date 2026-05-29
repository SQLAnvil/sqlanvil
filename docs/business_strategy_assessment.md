# Business Strategy Assessment & V1 Commercialisation Roadmap

**Status:** Draft / Strategic Blueprint
**Author:** Antigravity (Advanced Agentic Coding, Google DeepMind)
**Target:** SQLAnvil Product Launch & Supabase Partnership

---

## 1. Product Positioning & Value Proposition

SQLAnvil brings the rigor, dependency tracking, data-quality assertions, and incremental table management of **Google Cloud's Dataform** to **PostgreSQL and Supabase** natively, without requiring teams to adopt Google Cloud Platform or manage complex Docker-in-Docker setups.

### Primary Audience
* **Supabase Developers** outgrowing raw SQL migration scripts or manual migrations who want a declarative framework.
* **Reseller ETL & Inventory Foundry builders** (such as **ListAnvil**) executing complex near-instant inventory synchronisation and shipping calculations directly inside PostgreSQL schemas.
* **Modern Data Stack Teams** looking for a lightweight, native alternatives to DBT Core for Postgres databases.

---

## 2. Monetization Strategy: The Open-Core Hybrid Model

To build high developer adoption while capturing commercial value, we recommend a **hybrid open-core** licensing model (modeled after the successful DBT Core vs DBT Cloud dynamic):

```
┌────────────────────────────────────────────────────────┐
│                   SQLAnvil Cloud (SaaS)                │  ◀── PAID / COMMERCIAL
│   - Scheduled pipeline orchestrator (Cloud Runner)      │
│   - Visual schema lineage & real-time monitoring        │
│   - Team collaboration & automated alerts              │
└───────────────────────────┬────────────────────────────┘
                            │ (Inherits & Orchestrates)
┌───────────────────────────▼────────────────────────────┐
│                   SQLAnvil Core (CLI)                  │  ◀── FREE / OPEN-SOURCE
│   - SQLX compiler & dependency graph resolver          │      (Apache 2.0 Fork)
│   - Postgres & Supabase adapters (DDL/DML generator)    │
│   - Local testing, evaluations & assertions            │
└────────────────────────────────────────────────────────┘
```

### Free Tier (SQLAnvil Core - CLI)
* **License:** Apache License 2.0 (Permissive fork).
* **Included:** Local CLI binary (`sqlanvil compile`, `sqlanvil run`), basic Postgres/Supabase adapters, and standard SQLX macro/package capabilities.
* **Goal:** Drive organic bottom-up adoption, gain GitHub stargazers, build community trust, and capture high developer mindshare.

### Paid Tier (SQLAnvil Cloud / SaaS)
* **Product:** A hosted orchestrator/orchestration plane.
* **Features:**
  * **Hosted Runner:** Runs your `.sqlx` pipelines on a cron schedule or via webhook triggers in our cloud.
  * **Visual Lineage:** An interactive graph UI mapping your databases, views, and downstream assertions.
  * **Team Collaboration & Alerts:** Slack/Discord notifications on failed assertions or table-refresh timeouts.
  * **Enterprise Connectors**: Advanced PostgreSQL Foreign Data Wrappers (FDW) discovery and setup interfaces.

---

## 3. Partner & Marketing Channels

### Channel A: The Supabase Partner Directory
* **Strategy:** Submit the partner form at [forms.supabase.com/partner](https://forms.supabase.com/partner).
* **Timing:** **Hold off until V1 status is reached.** We want their review to be a flawless "wow" experience.
* **Content:** Leverage the [supabase-partner-description.txt](supabase-partner-description.txt) draft detailing RLS policy actions, Realtime publications, and pgvector indexes as first-class citizens.

### Channel B: Hacker News (Show HN)
* **Strategy:** Write a compelling, highly technical launch post.
* **Focus:** HN audience loves lightweight toolchains that solve real pain points without heavy SaaS lock-ins. Pitch it as *"The missing SQLX modeling layer for PostgreSQL/Supabase."*

### Channel C: ListAnvil Real-World Case Study
* **Strategy:** Publish a detailed technical post about migrating ListAnvil's ETL pipeline to SQLAnvil.
* **Impact:** Demonstrates that the framework successfully manages heavy Reseller ETL workloads with near-instant syncs under heavy production stress.

---

## 4. V1 Checklist & Roadmap to Launch

Before public launch, the following items should be completed:

- [ ] **Distributable Binaries:** Establish automated GitHub Actions to publish compiled CLI binaries under the `@sqlanvil/cli` npm scope.
- [ ] **Public Site (`sqlanvil.com`):** Complete the sibling `sqlanvil-com` repo static website with high-premium aesthetics, hosting quickstart guides and interactive macro examples.
- [ ] **pgvector Integration Sandbox:** Complete documentation showing pgvector extensions and how RAG pipelines are modeled.
- [ ] **GitHub Visibility:** Maintain a private repository during stealth development, and toggle to public only when the NPM packages, Vercel website, and Supabase Partner forms are finalized simultaneously.
