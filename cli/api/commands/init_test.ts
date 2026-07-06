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
      "definitions/outputs/sales/daily_sales.sqlx",
      "definitions/outputs/reporting/product_revenue.sqlx",
      "definitions/test/assert_sales_amounts_positive.sqlx"
    ]) {
      expect(fs.existsSync(path.join(projectDir, sample)), sample).equals(true);
    }
    for (const kept of ["definitions/sources", "definitions/intermediate", "includes"]) {
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
    // The demo view refs the demo table; the assertion states the business rule.
    const view = fs.readFileSync(
      path.join(projectDir, "definitions/outputs/reporting/product_revenue.sqlx"),
      "utf8"
    );
    expect(view).to.contain('ref("daily_sales")');
    const assertion = fs.readFileSync(
      path.join(projectDir, "definitions/test/assert_sales_amounts_positive.sqlx"),
      "utf8"
    );
    expect(assertion).to.contain('type: "assertion"');
  });
});
