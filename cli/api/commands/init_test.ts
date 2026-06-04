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

  test("bigquery project (default) keeps defaultProject/defaultLocation and writes no creds file", async () => {
    const projectDir = tmpDirFixture.createNewTmpDir();

    await init(projectDir, { defaultDatabase: "my-proj", defaultLocation: "US" });

    const settings = readSettings(projectDir);
    expect(settings.defaultProject).equals("my-proj");
    expect(settings.defaultLocation).equals("US");
    expect(settings.warehouse ?? "bigquery").equals("bigquery");
    expect(fs.existsSync(credentialsPath(projectDir))).equals(false);
  });
});
