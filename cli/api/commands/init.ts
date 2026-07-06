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
  // Postgres/Supabase: a named connection for the sample cross-warehouse BigQuery source.
  // runner-extract needs no Vault secret and no wrappers extension — the CLI reads BigQuery at
  // run time (credentials go under `connections` in .df-credentials.json when you first run it).
  if (isPostgresLike) {
    workflowSettings.connections = {
      bigquery_public: sqlanvil.ConnectionConfig.create({
        platform: "bigquery",
        project: "bigquery-public-data",
        dataset: "geo_us_boundaries",
        billingProject: "REPLACE_WITH_YOUR_GCP_PROJECT",
        mode: "runner-extract"
      })
    };
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
  const sourcesDir = mkdir("definitions", "sources");
  const intermediateDir = mkdir("definitions", "intermediate");
  const salesDir = mkdir("definitions", "outputs", "sales");
  const reportingDir = mkdir("definitions", "outputs", "reporting");
  const testDir = mkdir("definitions", "test");
  keep(mkdir("includes"));

  // Sample project: declarations in sources/ → staging views in intermediate/ → aggregate
  // tables in outputs/ → a business-rule assertion in test/. Everything compiles out of the
  // box; `run` works once the source declarations point at real data (validate tells you
  // exactly what's missing). MySQL warehouses can't read cross-warehouse connections, so they
  // skip the BigQuery source. All sample SQL is dialect-neutral.
  const withBigQuerySource = warehouse !== "mysql";

  write(
    path.join(sourcesDir, "app_orders.sqlx"),
    `-- A declaration: a table that already exists in your warehouse (created by your
-- application, an import, or another pipeline). Point name/dataset at a real table —
-- downstream models read it with \${ref("app_orders")}.
config {
  type: "declaration",
  name: "app_orders",
  description: "Raw orders table owned by the application — replace with one of your tables."
}
`
  );
  write(
    path.join(intermediateDir, "stg_app_orders.sqlx"),
    `config {
  type: "view",
  description: "Staging view over the raw orders: rename, cast, and filter here — downstream models only read staged data."
}

SELECT
  order_id,
  product,
  quantity,
  amount,
  postal_code,
  ordered_at
FROM \${ref("app_orders")}
WHERE amount IS NOT NULL
`
  );
  write(
    path.join(salesDir, "daily_sales.sqlx"),
    `config {
  type: "table",
  description: "Sales by day and product, built from the staged orders."
}

SELECT
  CAST(ordered_at AS DATE) AS sale_date,
  product,
  SUM(quantity) AS units_sold,
  SUM(amount) AS revenue
FROM \${ref("stg_app_orders")}
GROUP BY CAST(ordered_at AS DATE), product
`
  );
  write(
    path.join(reportingDir, "product_revenue.sqlx"),
    `config {
  type: "view",
  description: "Revenue by product, straight off the staged orders."
}

SELECT
  product,
  SUM(quantity) AS units_sold,
  SUM(amount) AS revenue
FROM \${ref("stg_app_orders")}
GROUP BY product
`
  );
  write(
    path.join(testDir, "assert_sales_amounts_positive.sqlx"),
    `config {
  type: "assertion",
  description: "Business rule: every sales row has positive units and revenue."
}

-- An assertion FAILS when its query returns rows — select the violations.
SELECT *
FROM \${ref("daily_sales")}
WHERE units_sold <= 0 OR revenue <= 0
`
  );

  if (withBigQuerySource) {
    write(
      path.join(sourcesDir, "bigquery_zip_codes.sqlx"),
      isBigQuery
        ? `-- A declaration for a table in another project: Google's public ZIP geo data.
-- BigQuery reads it natively — \${ref("zip_codes")} resolves to the full name.
config {
  type: "declaration",
  database: "bigquery-public-data",
  schema: "geo_us_boundaries",
  name: "zip_codes",
  description: "US ZIP codes from BigQuery public data."
}
`
        : `-- A cross-warehouse source: Google's public ZIP geo data in BigQuery, read through
-- the "bigquery_public" connection (see workflow_settings.yaml). With
-- mode: runner-extract the CLI reads BigQuery at run time and materializes the rows
-- as a plain table here — \${ref("zip_codes")} works like any other source.
-- Scaffold real sources with:  sqlanvil introspect bigquery_public <dataset.table>
config {
  type: "declaration",
  connection: "bigquery_public",
  name: "zip_codes",
  description: "US ZIP codes from BigQuery public data, materialized by runner-extract.",
  columnTypes: {
    zip_code: "text",
    city: "text",
    state_code: "text"
  }
}
`
    );
    write(
      path.join(intermediateDir, "stg_zip_codes.sqlx"),
      `config {
  type: "view",
  description: "Staged ZIP geography from the BigQuery source."
}

SELECT
  zip_code,
  city,
  state_code
FROM \${ref("zip_codes")}
`
    );
    write(
      path.join(reportingDir, "orders_by_region.sqlx"),
      `config {
  type: "table",
  description: "Orders and revenue by state/city — joins both staged sources."
}

SELECT
  z.state_code,
  z.city,
  COUNT(*) AS orders,
  SUM(o.amount) AS revenue
FROM \${ref("stg_app_orders")} o
JOIN \${ref("stg_zip_codes")} z
  ON z.zip_code = o.postal_code
GROUP BY z.state_code, z.city
`
    );
  }

  return {
    filesWritten,
    dirsCreated
  };
}
