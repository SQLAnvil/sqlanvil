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

// A starter PostgresConnection (strict JSON — no comment keys; the credentials parser rejects
// them). Supabase points at the project's db host with SSL required; plain Postgres at localhost.
function postgresCredentialsTemplate(warehouse: string): string {
  const isSupabase = warehouse === "supabase";
  const template = {
    host: isSupabase ? "db.<project-ref>.supabase.co" : "localhost",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "",
    sslMode: isSupabase ? "require" : "disable",
    defaultSchema: "public"
  };
  return `${JSON.stringify(template, null, 2)}\n`;
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

  const warehouse = projectConfig.warehouse || "supabase";
  const isBigQuery = warehouse === "bigquery";

  // The order that fields are set here is preserved in the written yaml.
  const workflowSettings: sqlanvil.IWorkflowSettings = {
    sqlanvilCoreVersion: version
  };
  // BigQuery is core's implicit warehouse when the key is omitted, so it's the only
  // one we leave out; Supabase (the init default) and Postgres set `warehouse:` explicitly.
  if (!isBigQuery) {
    workflowSettings.warehouse = warehouse;
  }
  // defaultProject / defaultLocation are BigQuery-only — they have no meaning for Postgres/Supabase.
  if (isBigQuery) {
    workflowSettings.defaultProject = projectConfig.defaultDatabase;
    workflowSettings.defaultLocation = projectConfig.defaultLocation;
  }
  workflowSettings.defaultDataset = projectConfig.defaultSchema || "sqlanvil";
  workflowSettings.defaultAssertionDataset =
    projectConfig.assertionSchema || "sqlanvil_assertions";
  // Iceberg is a BigQuery concept.
  if (isBigQuery && projectConfig.defaultIcebergConfig) {
    workflowSettings.defaultIcebergConfig = projectConfig.defaultIcebergConfig;
  }
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

  fs.writeFileSync(workflowSettingsYamlPath, dumpYaml(workflowSettings));
  filesWritten.push(workflowSettingsYamlPath);

  fs.writeFileSync(gitignorePath, gitIgnoreContents);
  filesWritten.push(gitignorePath);

  // Postgres/Supabase: scaffold a credentials template (the connection lives in a separate,
  // gitignored file — not in workflow_settings.yaml). BigQuery credentials come from gcloud / a
  // BigQuery key, so no template is written for it.
  if (!isBigQuery) {
    fs.writeFileSync(
      path.join(projectDir, CREDENTIALS_FILENAME),
      postgresCredentialsTemplate(warehouse)
    );
    filesWritten.push(path.join(projectDir, CREDENTIALS_FILENAME));
  }

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
