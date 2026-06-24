import { ArtifactView, queryParquet } from "sa/cli/api/dbadapters/duckdb_artifacts";

/**
 * `sqlanvil docs` — render a self-contained HTML catalog of a project from its Parquet artifacts:
 * models (type, tags, description, last-run status), their columns, and object-level dependency
 * edges. No column-level lineage, no graph viz, no server/CDN — one openable HTML file.
 */

export interface DocsModelEntry {
  readable: string;
  type: string;
  tags: string[];
  description: string;
  status?: string; // latest-run status, if a run has been recorded
  dependsOn: string[];
}

export interface DocsColumnEntry {
  readable: string;
  column: string;
  description: string;
}

export interface DocsModel {
  generatedAt: string;
  summary: { total: number; byType: Array<{ type: string; n: number }> };
  latestRun?: { runId: number; status: string };
  models: DocsModelEntry[];
  columns: DocsColumnEntry[];
}

function escapeHtml(value: string): string {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the structured catalog model from the artifact Parquet views (DuckDB). */
export async function buildDocsModel(
  views: ArtifactView[],
  generatedAt: string
): Promise<DocsModel> {
  const hasRuns = views.some(v => v.name === "runs");

  const actions = await queryParquet(
    "select readable_name, type, tags, description from actions order by type, readable_name",
    views
  );
  const dependencies = await queryParquet(
    "select from_readable, to_readable from dependencies",
    views
  );
  const columns = await queryParquet(
    "select readable_name, column_name, description from columns order by readable_name, column_name",
    views
  );

  let latestRun: { runId: number; status: string } | undefined;
  const statusByModel = new Map<string, string>();
  if (hasRuns) {
    const head = await queryParquet(
      "select max(run_id) as run_id from runs",
      views
    );
    const runId = head[0] && head[0].run_id !== null ? Number(head[0].run_id) : undefined;
    if (runId !== undefined) {
      const overall = await queryParquet(
        `select run_status from runs where run_id = ${runId} limit 1`,
        views
      );
      latestRun = { runId, status: overall[0] ? overall[0].run_status : "UNKNOWN" };
      const statuses = await queryParquet(
        `select readable_name, status from runs where run_id = ${runId}`,
        views
      );
      for (const row of statuses) {
        statusByModel.set(row.readable_name, row.status);
      }
    }
  }

  const dependsOn = new Map<string, string[]>();
  for (const dep of dependencies) {
    dependsOn.set(dep.from_readable, (dependsOn.get(dep.from_readable) || []).concat(dep.to_readable));
  }

  const byTypeMap = new Map<string, number>();
  const models: DocsModelEntry[] = actions.map(a => {
    byTypeMap.set(a.type, (byTypeMap.get(a.type) || 0) + 1);
    let tags: string[] = [];
    try {
      tags = JSON.parse(a.tags || "[]");
    } catch (e) {
      tags = [];
    }
    return {
      readable: a.readable_name,
      type: a.type,
      tags,
      description: a.description || "",
      status: statusByModel.get(a.readable_name),
      dependsOn: dependsOn.get(a.readable_name) || []
    };
  });

  return {
    generatedAt,
    summary: {
      total: models.length,
      byType: Array.from(byTypeMap.entries())
        .map(([type, n]) => ({ type, n }))
        .sort((x, y) => x.type.localeCompare(y.type))
    },
    latestRun,
    models,
    columns: columns.map(c => ({
      readable: c.readable_name,
      column: c.column_name,
      description: c.description || ""
    }))
  };
}

/** Render the catalog model as a single self-contained HTML page. Pure. */
export function renderDocsHtml(model: DocsModel): string {
  const summaryLine =
    `${model.summary.total} models — ` +
    model.summary.byType.map(t => `${t.n} ${t.type}`).join(", ");
  const runLine = model.latestRun
    ? `Last run: <strong>${escapeHtml(model.latestRun.status)}</strong> (run ${model.latestRun.runId})`
    : "No runs recorded yet.";

  const statusBadge = (status?: string) => {
    if (!status) {
      return "";
    }
    const cls = status === "SUCCESSFUL" ? "ok" : status === "FAILED" ? "fail" : "muted";
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  };

  const modelRows = model.models
    .map(
      m => `<tr data-search="${escapeHtml((m.readable + " " + m.type + " " + m.tags.join(" ")).toLowerCase())}">
      <td><code>${escapeHtml(m.readable)}</code></td>
      <td>${escapeHtml(m.type)}</td>
      <td>${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</td>
      <td>${statusBadge(m.status)}</td>
      <td>${m.dependsOn.map(d => `<code>${escapeHtml(d)}</code>`).join("<br>")}</td>
      <td>${escapeHtml(m.description)}</td>
    </tr>`
    )
    .join("\n");

  const columnRows = model.columns
    .map(
      c => `<tr><td><code>${escapeHtml(c.readable)}</code></td><td><code>${escapeHtml(
        c.column
      )}</code></td><td>${escapeHtml(c.description)}</td></tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SQLAnvil catalog</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem; max-width: 1100px; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #888; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8884; vertical-align: top; }
  th { font-weight: 600; }
  code { font-size: 12px; }
  .tag { background: #8883; border-radius: 4px; padding: 0 .35rem; font-size: 12px; }
  .badge { border-radius: 4px; padding: 0 .4rem; font-size: 12px; font-weight: 600; }
  .badge.ok { background: #1a7f37; color: #fff; }
  .badge.fail { background: #b62324; color: #fff; }
  .badge.muted { background: #8884; }
  #q { padding: .4rem .6rem; width: 320px; max-width: 100%; margin-bottom: .5rem; }
</style>
</head>
<body>
  <h1>SQLAnvil catalog</h1>
  <div class="meta">${escapeHtml(summaryLine)} &middot; ${runLine} &middot; generated ${escapeHtml(
    model.generatedAt
  )}</div>

  <input id="q" type="search" placeholder="Filter models…" oninput="filterModels(this.value)">
  <table id="models">
    <thead><tr><th>Model</th><th>Type</th><th>Tags</th><th>Last run</th><th>Depends on</th><th>Description</th></tr></thead>
    <tbody>
${modelRows}
    </tbody>
  </table>

  <h2>Columns</h2>
  <table>
    <thead><tr><th>Model</th><th>Column</th><th>Description</th></tr></thead>
    <tbody>
${columnRows || '<tr><td colspan="3" class="meta">No documented columns.</td></tr>'}
    </tbody>
  </table>

<script>
  function filterModels(q) {
    q = q.toLowerCase();
    for (const tr of document.querySelectorAll('#models tbody tr')) {
      tr.style.display = tr.getAttribute('data-search').includes(q) ? '' : 'none';
    }
  }
</script>
</body>
</html>
`;
}
