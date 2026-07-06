import { expect } from "chai";
import * as fs from "fs";
import { load as loadYaml } from "js-yaml";
import * as path from "path";

import { init } from "sa/cli/api/commands/init";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("init", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  const readSettings = (projectDir: string): any =>
    loadYaml(fs.readFileSync(path.join(projectDir, "workflow_settings.yaml"), "utf8"));

  const credentialsPath = (projectDir: string) => path.join(projectDir, ".df-credentials.json");

  test("postgres project sets warehouse, omits BigQuery-only fields, scaffolds creds template", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    await init(projectDir, { warehouse: "postgres", defaultSchema: "analytics" });

    const settings = readSettings(projectDir);
    expect(settings.warehouse).equals("postgres");
    expect(settings.defaultDataset).equals("analytics");
    expect(settings.defaultAssertionDataset).equals("sqlanvil_assertions");
    expect(settings.sqlanvilCoreVersion).to.be.a("string");
    expect(settings).to.not.have.property("defaultProject");
    expect(settings).to.not.have.property("defaultLocation");

    const creds = JSON.parse(fs.readFileSync(credentialsPath(projectDir), "utf8"));
    expect(creds).to.have.keys([
      "host",
      "port",
      "database",
      "user",
      "password",
      "sslMode",
      "defaultSchema"
    ]);
  });

  test("supabase project sets warehouse supabase and a require-ssl creds template", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    await init(projectDir, { warehouse: "supabase" });

    const settings = readSettings(projectDir);
    expect(settings.warehouse).equals("supabase");
    expect(settings).to.not.have.property("defaultProject");

    const creds = JSON.parse(fs.readFileSync(credentialsPath(projectDir), "utf8"));
    expect(creds.sslMode).equals("require");
  });

  test("bigquery project (explicit) keeps defaultProject/defaultLocation and writes no creds file", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    await init(projectDir, { warehouse: "bigquery", defaultDatabase: "my-proj", defaultLocation: "US" });

    const settings = readSettings(projectDir);
    expect(settings.defaultProject).equals("my-proj");
    expect(settings.defaultLocation).equals("US");
    expect(settings.warehouse ?? "bigquery").equals("bigquery");
    expect(fs.existsSync(credentialsPath(projectDir))).equals(false);
  });

  test("project with no warehouse defaults to supabase", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    await init(projectDir, {});

    const settings = readSettings(projectDir);
    expect(settings.warehouse).equals("supabase");
    expect(settings).to.not.have.property("defaultProject");
    expect(fs.existsSync(credentialsPath(projectDir))).equals(true);
  });

  test("postgres-like projects default the dataset to public; others to sqlanvil", async () => {
    const pgDir = tmpDirFixture.createNewTmpDir();
    await init(pgDir, { warehouse: "supabase" });
    expect(readSettings(pgDir).defaultDataset).equals("public");

    const bqDir = tmpDirFixture.createNewTmpDir();
    await init(bqDir, { warehouse: "bigquery", defaultDatabase: "p", defaultLocation: "US" });
    expect(readSettings(bqDir).defaultDataset).equals("sqlanvil");
  });

  test("supabase creds template points at the session pooler, never the IPv6-only direct host", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    await init(projectDir, { warehouse: "supabase" });
    const creds = JSON.parse(fs.readFileSync(credentialsPath(projectDir), "utf8"));
    expect(creds.host).to.contain("pooler.supabase.com");
    expect(creds.user).to.contain("postgres.");
  });

  test("scaffolds the workflow directories with sample DAG + assertion and .gitkeep for empty dirs", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    await init(projectDir, { warehouse: "postgres" });

    for (const sample of [
      "definitions/sources/app_orders.sqlx",
      "definitions/sources/bigquery_zip_codes.sqlx",
      "definitions/intermediate/stg_app_orders.sqlx",
      "definitions/intermediate/stg_zip_codes.sqlx",
      "definitions/outputs/sales/daily_sales.sqlx",
      "definitions/outputs/reporting/product_revenue.sqlx",
      "definitions/outputs/reporting/orders_by_region.sqlx",
      "definitions/test/assert_sales_amounts_positive.sqlx"
    ]) {
      expect(fs.existsSync(path.join(projectDir, sample)), sample).equals(true);
    }
    for (const kept of ["includes"]) {
      expect(fs.existsSync(path.join(projectDir, kept, ".gitkeep")), kept).equals(true);
    }
    // Retired scaffold dirs are gone.
    for (const gone of [
      "definitions/sources/ecommerce",
      "definitions/outputs/orders",
      "definitions/outputs/marketing",
      "definitions/extra"
    ]) {
      expect(fs.existsSync(path.join(projectDir, gone)), gone).equals(false);
    }
    // Outputs read the intermediate views, which read the source declarations.
    const daily = fs.readFileSync(
      path.join(projectDir, "definitions/outputs/sales/daily_sales.sqlx"),
      "utf8"
    );
    expect(daily).to.contain('ref("stg_app_orders")');
    const stg = fs.readFileSync(
      path.join(projectDir, "definitions/intermediate/stg_app_orders.sqlx"),
      "utf8"
    );
    expect(stg).to.contain('ref("app_orders")');
    const assertion = fs.readFileSync(
      path.join(projectDir, "definitions/test/assert_sales_amounts_positive.sqlx"),
      "utf8"
    );
    expect(assertion).to.contain('type: "assertion"');
    // The cross-warehouse source rides the bigquery_public connection in workflow_settings.
    const settings = readSettings(projectDir);
    expect(settings.connections.bigquery_public.platform).equals("bigquery");
    expect(settings.connections.bigquery_public.mode).equals("runner-extract");
  });

  test("mysql projects skip the cross-warehouse BigQuery sample (connections unsupported)", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    await init(projectDir, { warehouse: "mysql" });
    expect(fs.existsSync(path.join(projectDir, "definitions/sources/app_orders.sqlx"))).equals(true);
    expect(fs.existsSync(path.join(projectDir, "definitions/sources/bigquery_zip_codes.sqlx"))).equals(false);
    expect(readSettings(projectDir)).to.not.have.property("connections");
  });

  test("bigquery projects declare the public table natively (no connection)", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    await init(projectDir, { warehouse: "bigquery", defaultDatabase: "p", defaultLocation: "US" });
    const decl = fs.readFileSync(
      path.join(projectDir, "definitions/sources/bigquery_zip_codes.sqlx"),
      "utf8"
    );
    expect(decl).to.contain('database: "bigquery-public-data"');
    expect(decl).to.not.contain("connection:");
    expect(readSettings(projectDir)).to.not.have.property("connections");
  });
});
