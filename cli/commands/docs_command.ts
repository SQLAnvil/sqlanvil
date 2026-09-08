import * as fs from "fs";
import * as path from "path";

import { TARGET_DIR } from "sa/cli/api/commands/artifacts";
import { buildDocsModel, renderDocsHtml } from "sa/cli/api/commands/docs";
import { NO_ARTIFACTS, resolveArtifactViews } from "sa/cli/commands/artifact_views";
import { projectDirOption } from "sa/cli/common_options";
import { printError, printSuccess } from "sa/cli/console";
import { ICommand } from "sa/cli/yargswrapper";

async function runDocs(projectDir: string): Promise<number> {
  const { views, hasCatalog } = resolveArtifactViews(projectDir);
  if (!hasCatalog) {
    printError(NO_ARTIFACTS);
    return 1;
  }
  const model = await buildDocsModel(views, new Date().toISOString());
  const html = renderDocsHtml(model);
  const outDir = path.join(projectDir, TARGET_DIR, "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "index.html");
  fs.writeFileSync(outFile, html);
  printSuccess(`Wrote catalog to ${outFile}`);
  return 0;
}

export const docsCommand: ICommand = {
  format: `docs [${projectDirOption.name}]`,
  description:
    "Generate a self-contained HTML catalog of the project (models, columns, dependencies, " +
    "last-run status) at target/docs/index.html, from the artifacts.",
  positionalOptions: [projectDirOption],
  options: [],
  processFn: async (argv: any) => runDocs(argv[projectDirOption.name])
};
