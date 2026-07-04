# GEMINI.md

Context/memory file for the Gemini CLI in the sqlanvil repo.

- **Writing sqlanvil data projects** (`.sqlx`, `workflow_settings.yaml`, `.df-credentials.json`
  for PostgreSQL / Supabase / MySQL / MariaDB): follow [`AGENTS.md`](./AGENTS.md). It is the
  cross-agent authoring guide and corrects the Dataform/BigQuery assumptions that produce broken
  sqlanvil code.
- **Working on the sqlanvil codebase** (TypeScript, Bazel, protos): follow
  [`CLAUDE.md`](./CLAUDE.md).
- **Config field source of truth:** `protos/configs.proto`.
