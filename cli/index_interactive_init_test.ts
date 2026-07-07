import { assert, expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs-extra";
import { load as loadYaml } from "js-yaml";
import * as path from "path";

import { cliEntryPointPath } from "sa/cli/index_test_base";
import {
  CONVERT_OUT_QUESTION,
  CONVERT_SOURCE_QUESTION,
  CREDS_DATABASE_QUESTION,
  CREDS_HOST_QUESTION,
  CREDS_PASSWORD_QUESTION,
  CREDS_PORT_QUESTION,
  CREDS_SSLMODE_QUESTION,
  CREDS_USER_QUESTION,
  INIT_BQ_LOCATION_QUESTION,
  INIT_BQ_PROJECT_QUESTION,
  INIT_CONFIGURE_CREDS_QUESTION,
  INIT_DEFAULT_SCHEMA_QUESTION,
  INIT_INCLUDE_BQ_SOURCE_QUESTION,
  INIT_INCLUDE_SAMPLE_QUESTION,
  INIT_MODE_QUESTION,
  INIT_PROJECT_DIR_QUESTION,
  INIT_WAREHOUSE_QUESTION,
  withDefault
} from "sa/cli/interactive_init";
import { getProcessResult, nodePath, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("init --interactive", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  const runInteractiveInit = (projectDir: string, testInputs: Record<string, string>) =>
    getProcessResult(
      execFile(nodePath, [cliEntryPointPath, "init", projectDir, "--interactive"], {
        env: { ...process.env, DATAFORM_CLI_TEST_INPUTS: JSON.stringify(testInputs) }
      })
    );

  const readSettings = (projectDir: string): any =>
    loadYaml(fs.readFileSync(path.join(projectDir, "workflow_settings.yaml"), "utf8"));

  test("fresh supabase project with credentials Q&A", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const testInputs = {
      [withDefault(INIT_MODE_QUESTION, "fresh")]: "fresh",
      [withDefault(INIT_WAREHOUSE_QUESTION, "supabase")]: "supabase",
      [withDefault(INIT_PROJECT_DIR_QUESTION, projectDir)]: "",
      [withDefault(INIT_DEFAULT_SCHEMA_QUESTION, "public")]: "",
      [withDefault(INIT_INCLUDE_SAMPLE_QUESTION, "y")]: "y",
      [withDefault(INIT_INCLUDE_BQ_SOURCE_QUESTION, "y")]: "n",
      [withDefault(INIT_CONFIGURE_CREDS_QUESTION, "y")]: "y",
      [withDefault(CREDS_HOST_QUESTION, "aws-1-<region>.pooler.supabase.com")]:
        "aws-1-us-east-1.pooler.supabase.com",
      [withDefault(CREDS_PORT_QUESTION, "5432")]: "",
      [withDefault(CREDS_DATABASE_QUESTION, "postgres")]: "",
      [withDefault(CREDS_USER_QUESTION, "postgres.<your-project-ref>")]: "postgres.abcdef123456",
      [CREDS_PASSWORD_QUESTION]: "hunter2",
      [withDefault(CREDS_SSLMODE_QUESTION, "require")]: ""
    };

    const result = await runInteractiveInit(projectDir, testInputs);
    expect(result.exitCode).equals(0);

    const settings = readSettings(projectDir);
    expect(settings.warehouse).equals("supabase");
    expect(settings.defaultDataset).equals("public");
    // The BigQuery sample source was declined — no connections block, no BQ sample files.
    expect(settings).to.not.have.property("connections");
    assert.isFalse(
      fs.existsSync(path.join(projectDir, "definitions", "sources", "bigquery_zip_codes.sqlx"))
    );
    assert.isFalse(
      fs.existsSync(path.join(projectDir, "definitions", "outputs", "reporting", "orders_by_region.sqlx"))
    );
    // The rest of the sample project is present.
    assert.isTrue(
      fs.existsSync(path.join(projectDir, "definitions", "sources", "app_orders.sqlx"))
    );
    assert.isTrue(
      fs.existsSync(path.join(projectDir, "definitions", "outputs", "sales", "daily_sales.sqlx"))
    );

    // Credentials came from the Q&A, not the placeholder template.
    const creds = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".df-credentials.json"), "utf8")
    );
    expect(creds.host).equals("aws-1-us-east-1.pooler.supabase.com");
    expect(creds.port).equals(5432);
    expect(creds.database).equals("postgres");
    expect(creds.user).equals("postgres.abcdef123456");
    expect(creds.password).equals("hunter2");
    expect(creds.sslMode).equals("require");
  });

  test("fresh postgres project without sample or credentials Q&A", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const testInputs = {
      [withDefault(INIT_MODE_QUESTION, "fresh")]: "",
      [withDefault(INIT_WAREHOUSE_QUESTION, "supabase")]: "postgres",
      [withDefault(INIT_PROJECT_DIR_QUESTION, projectDir)]: "",
      [withDefault(INIT_DEFAULT_SCHEMA_QUESTION, "public")]: "analytics",
      [withDefault(INIT_INCLUDE_SAMPLE_QUESTION, "y")]: "n",
      [withDefault(INIT_CONFIGURE_CREDS_QUESTION, "y")]: "n"
    };

    const result = await runInteractiveInit(projectDir, testInputs);
    expect(result.exitCode).equals(0);

    const settings = readSettings(projectDir);
    expect(settings.warehouse).equals("postgres");
    expect(settings.defaultDataset).equals("analytics");
    expect(settings).to.not.have.property("connections");

    // Bare directories: scaffold dirs exist (gitkept), no sample files.
    const sourcesDir = path.join(projectDir, "definitions", "sources");
    assert.isTrue(fs.existsSync(path.join(sourcesDir, ".gitkeep")));
    assert.isFalse(fs.existsSync(path.join(sourcesDir, "app_orders.sqlx")));
    assert.isTrue(fs.existsSync(path.join(projectDir, "definitions", "test", ".gitkeep")));

    // Credentials Q&A declined — the placeholder template is written instead.
    const creds = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".df-credentials.json"), "utf8")
    );
    expect(creds.host).equals("localhost");
    expect(creds.password).equals("");
  });

  test("fresh bigquery project prompts for project and location", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const testInputs = {
      [withDefault(INIT_MODE_QUESTION, "fresh")]: "fresh",
      [withDefault(INIT_WAREHOUSE_QUESTION, "supabase")]: "bigquery",
      [withDefault(INIT_PROJECT_DIR_QUESTION, projectDir)]: "",
      [INIT_BQ_PROJECT_QUESTION]: "my-gcp-project",
      [INIT_BQ_LOCATION_QUESTION]: "us-central1",
      [withDefault(INIT_DEFAULT_SCHEMA_QUESTION, "sqlanvil")]: "",
      [withDefault(INIT_INCLUDE_SAMPLE_QUESTION, "y")]: "y"
    };

    const result = await runInteractiveInit(projectDir, testInputs);
    expect(result.exitCode).equals(0);

    const settings = readSettings(projectDir);
    expect(settings.defaultProject).equals("my-gcp-project");
    expect(settings.defaultLocation).equals("us-central1");
    expect(settings.defaultDataset).equals("sqlanvil");
    // BigQuery credentials come from init-creds; no credentials file is written.
    assert.isFalse(fs.existsSync(path.join(projectDir, ".df-credentials.json")));
    // The BigQuery sample source is a native declaration here.
    const zipCodes = fs.readFileSync(
      path.join(projectDir, "definitions", "sources", "bigquery_zip_codes.sqlx"),
      "utf8"
    );
    expect(zipCodes).contains('database: "bigquery-public-data"');
  });

  test("convert flow runs the Dataform converter and leaves the source untouched", async () => {
    const srcDir = tmpDirFixture.createNewTmpDir();
    const outDir = tmpDirFixture.createNewTmpDir();
    const workDir = tmpDirFixture.createNewTmpDir();

    fs.writeFileSync(
      path.join(srcDir, "dataform.json"),
      JSON.stringify({
        warehouse: "bigquery",
        defaultDatabase: "my-source-project",
        defaultSchema: "dataform"
      })
    );
    fs.mkdirpSync(path.join(srcDir, "definitions"));
    fs.writeFileSync(
      path.join(srcDir, "definitions", "example.sqlx"),
      'config { type: "view" }\nselect 1 as x\n'
    );
    const sourceListingBefore = fs.readdirSync(srcDir).sort();

    const testInputs = {
      [withDefault(INIT_MODE_QUESTION, "fresh")]: "convert",
      [CONVERT_SOURCE_QUESTION]: srcDir,
      [CONVERT_OUT_QUESTION]: outDir,
      [withDefault(INIT_CONFIGURE_CREDS_QUESTION, "y")]: "n"
    };

    const result = await runInteractiveInit(workDir, testInputs);
    expect(result.exitCode).equals(0);

    const settings = loadYaml(
      fs.readFileSync(path.join(outDir, "workflow_settings.yaml"), "utf8")
    ) as any;
    expect(settings.warehouse).equals("supabase");
    assert.isTrue(fs.existsSync(path.join(outDir, "migration-report.md")));
    assert.isTrue(fs.existsSync(path.join(outDir, "definitions", "example.sqlx")));

    // Source is read-only: same files, no additions.
    expect(fs.readdirSync(srcDir).sort()).deep.equals(sourceListingBefore);
  });
});
