// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { exampleActionDescriptor } from "sa/core/actions/index_test";
import { asPlainObject, suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import {
  coreExecutionRequestFromPath,
  runMainInVm,
  VALID_WORKFLOW_SETTINGS_YAML
} from "sa/testing/run_core";

suite("declaration", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test(`declarations can be loaded`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/actions.yaml"),
      `
actions:
- declaration:
    name: action`
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    expect(asPlainObject(result.compile.compiledGraph.declarations)).deep.equals(
      asPlainObject([
        {
          target: {
            database: "defaultProject",
            schema: "defaultDataset",
            name: "action"
          },
          canonicalTarget: {
            database: "defaultProject",
            schema: "defaultDataset",
            name: "action"
          }
        }
      ])
    );
  });

  test(`declarations can be loaded with tags`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/actions.yaml"),
      `
actions:
- declaration:
    name: action
    tags: ["tag1"]`
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    expect(asPlainObject(result.compile.compiledGraph.declarations)).deep.equals(
      asPlainObject([
        {
          target: {
            database: "defaultProject",
            schema: "defaultDataset",
            name: "action"
          },
          canonicalTarget: {
            database: "defaultProject",
            schema: "defaultDataset",
            name: "action"
          },
          tags: ["tag1"]
        }
      ])
    );
  });

  test(`fails when filename is defined for declaration`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/actions.yaml"),
      `
actions:
- declaration:
    fileName: doesnotexist.sql
    name: name`
    );

    expect(() => runMainInVm(coreExecutionRequestFromPath(projectDir))).to.throw(
      `Unexpected property "fileName", or property value type of "string" is incorrect. See https://github.com/sqlanvil/docs/blob/main/reference/configs.md#sqlanvil-ActionConfigs for allowed properties.`
    );
  });

  test(`fails when target name is not defined for declaration`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/actions.yaml"),
      `
actions:
- declaration:
    dataset: test`
    );

    expect(() => runMainInVm(coreExecutionRequestFromPath(projectDir))).to.throw(
      "Declarations must have a populated 'name' field."
    );
  });

  suite("sqlx and JS API config options", () => {
    const declarationConfig = `{
    type: "declaration",
    name: "name",
    schema: "dataset",
    database: "project",
    description: "description",
    ${exampleActionDescriptor.inputSqlxConfigBlock}
}`;
    [
      {
        filename: "declaration.sqlx",
        fileContents: `
config ${declarationConfig}`
      },
      {
        filename: "declaration.js",
        fileContents: `declare(${declarationConfig})`
      }
    ].forEach(testParameters => {
      test(`for declarations configured in a ${testParameters.filename} file`, () => {
        const projectDir = tmpDirFixture.createNewTmpDir();
        fs.writeFileSync(
          path.join(projectDir, "workflow_settings.yaml"),
          VALID_WORKFLOW_SETTINGS_YAML
        );
        fs.mkdirSync(path.join(projectDir, "definitions"));
        fs.writeFileSync(
          path.join(projectDir, `definitions/${testParameters.filename}`),
          testParameters.fileContents
        );

        const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

        expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
        expect(asPlainObject(result.compile.compiledGraph.declarations)).deep.equals(
          asPlainObject([
            {
              target: {
                database: "project",
                schema: "dataset",
                name: "name"
              },
              canonicalTarget: {
                database: "project",
                schema: "dataset",
                name: "name"
              },
              fileName: `definitions/${testParameters.filename}`,
              actionDescriptor: exampleActionDescriptor.outputActionDescriptor
            }
          ])
        );
      });
    });
  });

  test(`action config options`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(path.join(projectDir, "definitions/operation.sqlx"), "SELECT 1");
    fs.writeFileSync(
      path.join(projectDir, "definitions/actions.yaml"),
      `
actions:
- declaration:
    name: name
    dataset: dataset
    project: project
    description: description
`
    );

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    expect(asPlainObject(result.compile.compiledGraph.declarations)).deep.equals(
      asPlainObject([
        {
          target: {
            database: "project",
            schema: "dataset",
            name: "name"
          },
          canonicalTarget: {
            database: "project",
            schema: "dataset",
            name: "name"
          },
          actionDescriptor: {
            description: "description"
          }
        }
      ])
    );
  });

  test(`SQLx backward compatible with LegacyConfig`, () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), VALID_WORKFLOW_SETTINGS_YAML);
    fs.mkdirSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/legacy.sqlx"),
      `config { 
  type: "declaration",
  name: "legacy",
  dataset: "legacyDataset",
  project: "legacyProject"
}`
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/current.sqlx"),
      `config { 
  type: "declaration",
  name: "current",
  schema: "currentSchema",
  database: "currentDatabase"
}`
    );    

    const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

    expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
    expect(asPlainObject(result.compile.compiledGraph.declarations)).deep.equals(
      asPlainObject([
        {
          target: {
            database: "currentDatabase",
            schema: "currentSchema",
            name: "current"
          },
          canonicalTarget: {
            database: "currentDatabase",
            schema: "currentSchema",
            name: "current"
          },
          fileName: "definitions/current.sqlx"
        },
        {
          target: {
            database: "legacyProject",
            schema: "legacyDataset",
            name: "legacy"
          },
          canonicalTarget: {
            database: "legacyProject",
            schema: "legacyDataset",
            name: "legacy"
          },
          fileName: "definitions/legacy.sqlx"
        },
      ])
    );
  });


  // Runner-extract connection declarations (1.22 semantics): the declared `schema:` names the
  // SOURCE dataset (overriding the connection default) AND the Postgres schema the extract
  // materializes into — so Dataform-style schema-qualified refs keep resolving after a
  // migration. Empty columnTypes compiles (introspect fills it in later); the run fails instead.
  test("connection declarations: declared schema drives source dataset + target schema; empty columnTypes compiles", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      [
        "warehouse: supabase",
        "defaultDataset: public",
        "defaultAssertionDataset: sqlanvil_assertions",
        "connections:",
        "  bq_acme:",
        "    platform: bigquery",
        "    project: acme-analytics",
        "    billingProject: acme-analytics",
        "    mode: runner-extract"
      ].join("\n")
    );
    fs.mkdirsSync(path.join(projectDir, "definitions"));
    fs.writeFileSync(
      path.join(projectDir, "definitions/zip_code.sqlx"),
      `config { type: "declaration", connection: "bq_acme", schema: "ods", name: "zip_code", columnTypes: {} }`
    );
    fs.writeFileSync(
      path.join(projectDir, "definitions/legacy_style.sqlx"),
      `config { type: "declaration", connection: "bq_acme", name: "no_schema", columnTypes: { id: "bigint" } }`
    );

    const graph = runMainInVm(coreExecutionRequestFromPath(projectDir)).compile.compiledGraph;
    expect(asPlainObject(graph.graphErrors.compilationErrors)).deep.equals([]);
    expect(graph.extracts.length).equals(2);

    const withSchema = graph.extracts.find((e: any) => e.sourceName === "zip_code");
    expect(withSchema.target.schema).equals("ods"); // materializes under the declared name
    expect(withSchema.dataset).equals("ods"); // reads acme-analytics.ods.zip_code
    expect(Object.keys(withSchema.columnTypes ?? {})).deep.equals([]); // compiles empty

    const legacy = graph.extracts.find((e: any) => e.sourceName === "no_schema");
    expect(legacy.target.schema).equals("bq_acme_ext"); // pre-1.22 behavior preserved
  });
});
