import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs-extra";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import * as path from "path";

import * as saapi from "sa/cli/api";
import { BigQueryDbAdapter } from "sa/cli/api/dbadapters/bigquery";
import { cliEntryPointPath, CREDENTIALS_PATH, DEFAULT_DATABASE } from "sa/cli/index_test_base";
import { version } from "sa/core/version";
import { corePackageTarPath, getProcessResult, nodePath, npmPath, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

// Live BigQuery tests for where `run` creates missing datasets (upstream #2408, SQLAnvil/sqlanvil#69).
// The expected location is never "US", the fallback when no location is set anywhere, so the tests
// can't pass by accident.
const EXPECTED_LOCATION = "EU";
const OTHER_LOCATION = "US";
const ALL_LOCATIONS = [EXPECTED_LOCATION, OTHER_LOCATION];
const DATASET_PREFIX = "sqlanvil_e2e_loc";

suite("location resolution", ({ beforeEach, afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);
  const dbadapter = new BigQueryDbAdapter(saapi.credentials.read(CREDENTIALS_PATH));
  let datasetsToDrop: string[];

  const uniqueDataset = () => {
    const dataset = `${DATASET_PREFIX}_${Math.random().toString(36).substring(2, 10)}`;
    datasetsToDrop.push(dataset);
    return dataset;
  };

  beforeEach("reset datasets to drop", () => {
    datasetsToDrop = [];
  });

  afterEach("drop datasets", async () => {
    // A dataset may have ended up in the wrong location if a test failed, so try both.
    for (const dataset of datasetsToDrop) {
      for (const location of ALL_LOCATIONS) {
        try {
          await dbadapter.execute(
            `drop schema if exists \`${DEFAULT_DATABASE}.${dataset}\` cascade`,
            { bigquery: { location } },
          );
        } catch (e) {
          // Best effort.
        }
      }
    }
  });

  async function setupProject(options: {
    dataset: string;
    location?: string;
    assertionDataset?: string;
  }): Promise<string> {
    const projectDir = tmpDirFixture.createNewTmpDir();
    const npmCacheDir = tmpDirFixture.createNewTmpDir();
    await getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "init",
        projectDir,
        DEFAULT_DATABASE,
        "--warehouse",
        "bigquery",
        "--bare",
      ]),
    );
    const workflowSettingsPath = path.join(projectDir, "workflow_settings.yaml");
    const workflowSettings = loadYaml(fs.readFileSync(workflowSettingsPath, "utf8")) as {
      [key: string]: any;
    };
    delete workflowSettings.sqlanvilCoreVersion;
    workflowSettings.defaultDataset = options.dataset;
    if (options.location) {
      workflowSettings.defaultLocation = options.location;
    } else {
      delete workflowSettings.defaultLocation;
    }
    if (options.assertionDataset) {
      workflowSettings.defaultAssertionDataset = options.assertionDataset;
    }
    fs.writeFileSync(workflowSettingsPath, dumpYaml(workflowSettings));
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      `{ "dependencies": { "@sqlanvil/core": "${version}" } }`,
    );
    await getProcessResult(
      execFile(npmPath, [
        "install",
        "--prefix",
        projectDir,
        "--cache",
        npmCacheDir,
        corePackageTarPath,
      ]),
    );
    return projectDir;
  }

  function writeDefinition(projectDir: string, name: string, contents: string) {
    const filePath = path.join(projectDir, "definitions", name);
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, contents);
  }

  function writeCredentials(location: string | undefined): string {
    const credentialsPath = path.join(tmpDirFixture.createNewTmpDir(), "credentials.json");
    const testCredentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    delete testCredentials.location;
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify(location ? { ...testCredentials, location } : testCredentials),
    );
    return credentialsPath;
  }

  const runCli = (projectDir: string, credentialsPath: string, args: string[] = []) =>
    getProcessResult(
      execFile(nodePath, [
        cliEntryPointPath,
        "run",
        projectDir,
        "--credentials",
        credentialsPath,
        ...args,
      ]),
    );

  async function datasetLocation(dataset: string): Promise<string | undefined> {
    for (const location of ALL_LOCATIONS) {
      // INFORMATION_SCHEMA.SCHEMATA only lists the datasets of the queried region.
      const { rows } = await dbadapter.execute(
        `select location
         from \`${DEFAULT_DATABASE}\`.\`region-${location.toLowerCase()}\`.INFORMATION_SCHEMA.SCHEMATA
         where schema_name = '${dataset}'`,
        { bigquery: { location } },
      );
      if (rows.length > 0) {
        return String(rows[0].location).toUpperCase();
      }
    }
    return undefined;
  }

  test(
    "without any location, new datasets are created in the location of the data read",
    { timeout: 300000 },
    async () => {
      // Source data in EXPECTED_LOCATION.
      const sourceDataset = uniqueDataset();
      await dbadapter.execute(
        `create schema \`${DEFAULT_DATABASE}.${sourceDataset}\` options (location = "${EXPECTED_LOCATION}");
         create table \`${DEFAULT_DATABASE}.${sourceDataset}.example\` as select 1 as id`,
        { bigquery: { location: EXPECTED_LOCATION } },
      );
      const source = `\`${DEFAULT_DATABASE}.${sourceDataset}.example\``;

      // A project without a location anywhere, writing to new datasets.
      const dataset = uniqueDataset();
      const assertionDataset = uniqueDataset();
      const projectDir = await setupProject({ dataset, assertionDataset });
      writeDefinition(
        projectDir,
        "example.sqlx",
        `
config { type: "table", assertions: { nonNull: ["id"] } }
SELECT * FROM ${source}
`,
      );
      // DECLARE must stay at the start of the block the statement is wrapped in.
      writeDefinition(
        projectDir,
        "example_incremental.sqlx",
        `
config { type: "incremental" }
pre_operations {
  DECLARE min_id INT64 DEFAULT 0;
}
SELECT * FROM ${source} WHERE id >= min_id
`,
      );
      writeDefinition(
        projectDir,
        "example_operation.sqlx",
        `
config { type: "operations", hasOutput: true }
CREATE OR REPLACE TABLE \${self()} AS SELECT * FROM ${source}
`,
      );

      const result = await runCli(projectDir, writeCredentials(undefined));

      expect(result.exitCode, result.stdout + result.stderr).equals(0);
      expect(await datasetLocation(dataset)).equals(EXPECTED_LOCATION);
      expect(await datasetLocation(assertionDataset)).equals(EXPECTED_LOCATION);
    },
  );

  test(
    "workflow_settings.yaml defaultLocation is used for new datasets",
    { timeout: 180000 },
    async () => {
      const dataset = uniqueDataset();
      const projectDir = await setupProject({ dataset, location: EXPECTED_LOCATION });
      writeDefinition(projectDir, "example.sqlx", `config { type: "table" }\nSELECT 1 AS id\n`);

      const result = await runCli(projectDir, writeCredentials(OTHER_LOCATION));

      expect(result.exitCode, result.stdout + result.stderr).equals(0);
      expect(await datasetLocation(dataset)).equals(EXPECTED_LOCATION);
    },
  );

  test("without any location, dry runs don't create datasets", { timeout: 180000 }, async () => {
    const dataset = uniqueDataset();
    const projectDir = await setupProject({ dataset });
    writeDefinition(
      projectDir,
      "example.sqlx",
      `
config { type: "table" }
SELECT 1 AS id
post_operations {
  ALTER TABLE \${self()} SET OPTIONS (description = "example");
}
`,
    );

    const result = await runCli(projectDir, writeCredentials(undefined), ["--dry-run"]);

    expect(result.exitCode, result.stdout + result.stderr).equals(0);
    expect(await datasetLocation(dataset)).equals(undefined);
  });

  test(
    "dry runs fully check the query of tables writing to a dataset that doesn't exist yet",
    { timeout: 180000 },
    async () => {
      const dataset = uniqueDataset();
      const projectDir = await setupProject({ dataset, location: EXPECTED_LOCATION });
      writeDefinition(
        projectDir,
        "example.sqlx",
        `
config { type: "table" }
pre_operations {
  DECLARE min_id INT64 DEFAULT 0;
}
SELECT no_such_column FROM (SELECT 1 AS id) WHERE id >= min_id
post_operations {
  ALTER TABLE \${self()} SET OPTIONS (description = "example");
}
`,
      );

      const result = await runCli(projectDir, writeCredentials(EXPECTED_LOCATION), ["--dry-run"]);

      // Only a syntax check of the script creating the dataset wouldn't catch this.
      expect(result.exitCode).equals(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).to.include("Unrecognized name: no_such_column");

      // The error position refers to the printed SQL (the statement wrapped in the script creating
      // the dataset), even though the error comes from dry-running the query separately.
      const printedSqlLines = output
        .split("\n")
        .filter((line) => line.trimStart().startsWith("> "))
        .map((line) => line.trimStart().slice(2));
      const [, line, column] = output.match(/no_such_column at \[(\d+):(\d+)\]/);
      expect(printedSqlLines[Number(line) - 1].slice(Number(column) - 1)).to.match(
        /^no_such_column/,
        output,
      );
      expect(await datasetLocation(dataset)).equals(undefined);
    },
  );
});
