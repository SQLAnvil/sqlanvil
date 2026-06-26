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

suite("import", ({ afterEach }) => {
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

  test("compiles a config-only type:import action into compiledGraph.imports", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx":
        `config { type: "import", import: { location: "gs://b/orders/*.parquet", format: "parquet" } }`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    expect(graph.imports.length).equals(1);
    const imp = graph.imports[0];
    expect(imp.target.name).equals("orders_in");
    expect(imp.location).equals("gs://b/orders/*.parquet");
    expect(imp.format).equals("parquet");
    // overwrite defaults to true when not set.
    expect(imp.overwrite).equals(true);
  });

  test("an imported table is ref()-able by a downstream model", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx":
        `config { type: "import", import: { location: "gs://b/orders/*.parquet", format: "parquet" } }`,
      "definitions/clean.sqlx":
        `config { type: "table" }\nSELECT * FROM ${"${ref(\"orders_in\")}"}`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const clean = graph.tables.find((t: any) => t.target.name === "clean");
    expect(clean.dependencyTargets.map((t: any) => t.name)).contains("orders_in");
  });

  test("rejects a BigQuery import from a non-gs:// source", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx":
        `config { type: "import", import: { location: "s3://b/orders/", format: "parquet" } }`
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("BigQuery imports support only gs://");
  });

  test("rejects an unknown import format", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx":
        `config { type: "import", import: { location: "gs://b/x/", format: "avro" } }`
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Invalid import format");
  });

  test("requires a location", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx": `config { type: "import", import: { format: "parquet" } }`
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("require a `location`");
  });

  test("honors explicit overwrite:false", () => {
    const graph = compileProject({
      "definitions/orders_in.sqlx":
        `config { type: "import", import: { location: "gs://b/o/*.csv", format: "csv", overwrite: false } }`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const imp = graph.imports[0];
    expect(imp.overwrite).equals(false);
    expect(imp.format).equals("csv");
  });
});
