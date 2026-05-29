import * as fs from "fs";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import { CREDENTIALS_FILENAME } from "sa/cli/api/commands/credentials";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";

const gitIgnoreContents = `
${CREDENTIALS_FILENAME}
node_modules/
`;

export interface IInitResult {
  filesWritten: string[];
  dirsCreated: string[];
}

export async function init(
  projectDir: string,
  projectConfig: sqlanvil.IProjectConfig
): Promise<IInitResult> {
  const workflowSettingsYamlPath = path.join(projectDir, "workflow_settings.yaml");
  const packageJsonPath = path.join(projectDir, "package.json");
  const gitignorePath = path.join(projectDir, ".gitignore");

  if (fs.existsSync(workflowSettingsYamlPath) || fs.existsSync(packageJsonPath)) {
    throw new Error(
      "Cannot init sqlanvil project, this already appears to be an NPM or sqlanvil directory."
    );
  }

  const filesWritten = [];
  const dirsCreated = [];

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir);
    dirsCreated.push(projectDir);
  }

  // The order that fields are set here is preserved in the written yaml.
  const workflowSettings: sqlanvil.IWorkflowSettings = {
    sqlanvilCoreVersion: version,
    defaultProject: projectConfig.defaultDatabase,
    defaultLocation: projectConfig.defaultLocation,
    defaultDataset: projectConfig.defaultSchema || "sqlanvil",
    defaultAssertionDataset: projectConfig.assertionSchema || "sqlanvil_assertions",
    defaultIcebergConfig: projectConfig.defaultIcebergConfig,
  };
  if (projectConfig.databaseSuffix) {
    workflowSettings.projectSuffix = projectConfig.databaseSuffix;
  }
  if (projectConfig.schemaSuffix) {
    workflowSettings.datasetSuffix = projectConfig.schemaSuffix;
  }
  if (projectConfig.tablePrefix) {
    workflowSettings.namePrefix = projectConfig.tablePrefix;
  }
  if (projectConfig.vars) {
    workflowSettings.vars = projectConfig.vars;
  }
  if (projectConfig.builtinAssertionNamePrefix) {
    workflowSettings.builtinAssertionNamePrefix = projectConfig.builtinAssertionNamePrefix;
  }
  if(projectConfig.defaultIcebergConfig) {
    workflowSettings.defaultIcebergConfig = projectConfig.defaultIcebergConfig;
  }

  fs.writeFileSync(workflowSettingsYamlPath, dumpYaml(workflowSettings));
  filesWritten.push(workflowSettingsYamlPath);

  fs.writeFileSync(gitignorePath, gitIgnoreContents);
  filesWritten.push(gitignorePath);

  // Make the default models, includes folders.
  const definitionsDir = path.join(projectDir, "definitions");
  fs.mkdirSync(definitionsDir);
  dirsCreated.push(definitionsDir);

  // Create Google's best-practice workflow directories inside definitions
  const sourcesDir = path.join(definitionsDir, "sources");
  fs.mkdirSync(sourcesDir);
  dirsCreated.push(sourcesDir);

  // Add sources/ecommerce subdirectory
  const ecommerceDir = path.join(sourcesDir, "ecommerce");
  fs.mkdirSync(ecommerceDir);
  dirsCreated.push(ecommerceDir);

  const intermediateDir = path.join(definitionsDir, "intermediate");
  fs.mkdirSync(intermediateDir);
  dirsCreated.push(intermediateDir);

  const outputsDir = path.join(definitionsDir, "outputs");
  fs.mkdirSync(outputsDir);
  dirsCreated.push(outputsDir);

  // Add outputs subdirectories (sales, orders, marketing)
  const salesDir = path.join(outputsDir, "sales");
  fs.mkdirSync(salesDir);
  dirsCreated.push(salesDir);

  const ordersDir = path.join(outputsDir, "orders");
  fs.mkdirSync(ordersDir);
  dirsCreated.push(ordersDir);

  const marketingDir = path.join(outputsDir, "marketing");
  fs.mkdirSync(marketingDir);
  dirsCreated.push(marketingDir);

  // Add test and extra subdirectories
  const testDir = path.join(definitionsDir, "test");
  fs.mkdirSync(testDir);
  dirsCreated.push(testDir);

  const extraDir = path.join(definitionsDir, "extra");
  fs.mkdirSync(extraDir);
  dirsCreated.push(extraDir);

  const includesDir = path.join(projectDir, "includes");
  fs.mkdirSync(includesDir);
  dirsCreated.push(includesDir);

  return {
    filesWritten,
    dirsCreated
  };
}
