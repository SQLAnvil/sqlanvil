import * as fs from "fs";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import { CREDENTIALS_FILENAME } from "sa/cli/api/commands/credentials";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";

const gitIgnoreContents = `
${CREDENTIALS_FILENAME}
.df-credentials*.json
node_modules/
`;

export interface IInitResult {
  filesWritten: string[];
  dirsCreated: string[];
}

// A starter PostgresConnection (strict JSON — no comment keys; the credentials parser rejects
// them). Supabase points at the SESSION POOLER (Dashboard → Connect → Session pooler): the
// direct `db.<ref>.supabase.co` host is IPv6-only, so it ENOTFOUNDs on most IPv4 networks —
// a first-run trap. Plain Postgres points at localhost.
function postgresCredentialsTemplate(warehouse: string): string {
  const isSupabase = warehouse === "supabase";
  const template = {
    host: isSupabase ? "aws-1-<region>.pooler.supabase.com" : "localhost",
    port: 5432,
    database: "postgres",
    user: isSupabase ? "postgres.<your-project-ref>" : "postgres",
    password: "",
    sslMode: isSupabase ? "require" : "disable",
    defaultSchema: "public"
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}

// A starter MysqlConnection (strict JSON — no comment keys). Points at a local
// MySQL/MariaDB instance with SSL disabled by default.
function mysqlCredentialsTemplate(): string {
  const template = {
    host: "localhost",
    port: 3306,
    database: "sqlanvil",
    user: "root",
    password: "",
    sslMode: "disable"
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
  // Postgres/Supabase default to the schema every instance already has; BigQuery/MySQL keep a
  // namespaced default (their "schema" is a dataset/database the run creates).
  const isPostgresLike = warehouse === "postgres" || warehouse === "supabase";
  workflowSettings.defaultDataset =
    projectConfig.defaultSchema || (isPostgresLike ? "public" : "sqlanvil");
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

  // Postgres/Supabase/MySQL: scaffold a credentials template (the connection lives in a separate,
  // gitignored file — not in workflow_settings.yaml). BigQuery credentials come from gcloud / a
  // BigQuery key, so no template is written for it.
  if (!isBigQuery) {
    fs.writeFileSync(
      path.join(projectDir, CREDENTIALS_FILENAME),
      warehouse === "mysql" ? mysqlCredentialsTemplate() : postgresCredentialsTemplate(warehouse)
    );
    filesWritten.push(path.join(projectDir, CREDENTIALS_FILENAME));
  }

  // Workflow directories: sources (declarations for data you read), intermediate (staging),
  // outputs (what the business consumes), test (assertions). Directories that start empty get a
  // .gitkeep so the scaffold survives the first commit (the compiler never reads dotfiles).
  const mkdir = (...segments: string[]): string => {
    const dir = path.join(projectDir, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    dirsCreated.push(dir);
    return dir;
  };
  const write = (filePath: string, contents: string) => {
    fs.writeFileSync(filePath, contents);
    filesWritten.push(filePath);
  };
  const keep = (dir: string) => write(path.join(dir, ".gitkeep"), "");

  mkdir("definitions");
  keep(mkdir("definitions", "sources"));
  keep(mkdir("definitions", "intermediate"));
  const salesDir = mkdir("definitions", "outputs", "sales");
  const reportingDir = mkdir("definitions", "outputs", "reporting");
  const testDir = mkdir("definitions", "test");
  keep(mkdir("includes"));

  // A tiny working DAG (table → view → assertion) so `sqlanvil compile` / `validate` / `run`
  // do something real out of the box. Deliberately dialect-neutral SQL — it runs unchanged on
  // all four warehouses. Replace with your own models.
  write(
    path.join(salesDir, "daily_sales.sqlx"),
    `config {
  type: "table",
  description: "Demo sales data created by sqlanvil init — replace with your own models."
}

SELECT 1 AS order_id, 'widget' AS product, 2 AS quantity, 19.98 AS amount
UNION ALL
SELECT 2 AS order_id, 'gadget' AS product, 1 AS quantity, 24.50 AS amount
UNION ALL
SELECT 3 AS order_id, 'widget' AS product, 3 AS quantity, 29.97 AS amount
`
  );
  write(
    path.join(reportingDir, "product_revenue.sqlx"),
    `config {
  type: "view",
  description: "Revenue by product — a downstream view built with ref()."
}

SELECT
  product,
  SUM(quantity) AS units_sold,
  SUM(amount) AS revenue
FROM \${ref("daily_sales")}
GROUP BY product
`
  );
  write(
    path.join(testDir, "assert_sales_amounts_positive.sqlx"),
    `config {
  type: "assertion",
  description: "Business rule: every sale has a positive quantity and amount."
}

-- An assertion FAILS when its query returns rows — select the violations.
SELECT *
FROM \${ref("daily_sales")}
WHERE quantity <= 0 OR amount <= 0
`
  );

  return {
    filesWritten,
    dirsCreated
  };
}
