// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import {
  coreExecutionRequestFromPath,
  runMainInVm,
  VALID_WORKFLOW_SETTINGS_YAML
} from "sa/testing/run_core";

suite("export", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  function compileProject(files: { [p: string]: string }) {
    const projectDir = tmpDirFixture.createNewTmpDir();
    if (!files["workflow_settings.yaml"]) {
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        VALID_WORKFLOW_SETTINGS_YAML
      );
    }
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(projectDir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    return runMainInVm(coreExecutionRequestFromPath(projectDir)).compile.compiledGraph;
  }

  test("compiles a type:export action into compiledGraph.exports with deps", () => {
    const graph = compileProject({
      "definitions/src.sqlx": `config { type: "table" }\nSELECT 1 AS id`,
      "definitions/dump.sqlx":
        `config { type: "export", export: { location: "gs://b/dump/", format: "parquet" } }\n` +
        `SELECT * FROM ${"${ref(\"src\")}"}`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    expect(graph.exports.length).equals(1);
    const exp = graph.exports[0];
    expect(exp.target.name).equals("dump");
    expect(exp.location).equals("gs://b/dump/");
    expect(exp.format).equals("parquet");
    // overwrite defaults to true when not set.
    expect(exp.overwrite).equals(true);
    // filename defaults to the action name.
    expect(exp.filename).equals("dump");
    expect(exp.query).contains("SELECT");
    expect(exp.dependencyTargets.map((t: any) => t.name)).contains("src");
  });

  test("rejects a BigQuery export to a non-gs:// location", () => {
    const graph = compileProject({
      "definitions/dump.sqlx":
        `config { type: "export", export: { location: "s3://b/x/", format: "parquet" } }\n` +
        `SELECT 1 AS id`
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("BigQuery exports support only gs://");
  });

  test("rejects an unknown export format", () => {
    const graph = compileProject({
      "definitions/dump.sqlx":
        `config { type: "export", export: { location: "gs://b/x/", format: "avro" } }\n` +
        `SELECT 1 AS id`
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Invalid export format");
  });

  test("honors explicit overwrite:false and filename", () => {
    const graph = compileProject({
      "definitions/dump.sqlx":
        `config { type: "export", export: { location: "gs://b/d/", format: "csv", overwrite: false, filename: "out" } }\n` +
        `SELECT 1 AS id`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const exp = graph.exports[0];
    expect(exp.overwrite).equals(false);
    expect(exp.filename).equals("out");
    expect(exp.format).equals("csv");
  });
});
