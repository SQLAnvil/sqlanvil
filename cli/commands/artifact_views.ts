import * as fs from "fs";
import * as path from "path";

import { TARGET_DIR } from "sa/cli/api/commands/artifacts";
import { ArtifactView } from "sa/cli/api/dbadapters/duckdb_artifacts";
import { print } from "sa/cli/console";

// Shared by the queryable-artifact commands (`query` / `inspect` / `docs`): locate the
// target/*.parquet views and print result rows.

export const NO_ARTIFACTS =
  "No artifacts found under target/. Run `sqlanvil compile` (or `run`) first.";

export function resolveArtifactViews(
  projectDir: string
): { views: ArtifactView[]; hasCatalog: boolean; hasRuns: boolean } {
  const catalogDir = path.join(projectDir, TARGET_DIR, "catalog");
  const runsDir = path.join(projectDir, TARGET_DIR, "runs");
  const views: ArtifactView[] = [];
  for (const name of ["actions", "dependencies", "columns"]) {
    const file = path.join(catalogDir, `${name}.parquet`);
    if (fs.existsSync(file)) {
      views.push({ name, glob: file });
    }
  }
  const hasRuns =
    fs.existsSync(runsDir) && fs.readdirSync(runsDir).some(f => f.endsWith(".parquet"));
  if (hasRuns) {
    views.push({ name: "runs", glob: path.join(runsDir, "*.parquet") });
  }
  return { views, hasCatalog: views.some(v => v.name === "actions"), hasRuns };
}

export function printArtifactRows(rows: any[]): void {
  if (!rows || rows.length === 0) {
    print("(0 rows)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c =>
    Math.max(
      c.length,
      ...rows.map(r => String(r[c] === null || r[c] === undefined ? "" : r[c]).length)
    )
  );
  const fmtRow = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  print(fmtRow(cols));
  print(fmtRow(widths.map(w => "-".repeat(w))));
  for (const row of rows) {
    print(fmtRow(cols.map(c => String(row[c] === null || row[c] === undefined ? "" : row[c]))));
  }
  print(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}
