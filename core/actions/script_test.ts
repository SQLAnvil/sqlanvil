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

suite("script", ({ afterEach }) => {
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

  const LOADER_PY = `print("hello")\n`;

  test("python: actions.yaml sugar compiles into compiledGraph.scripts", () => {
    const graph = compileProject({
      "loader/load_openaddresses.py": LOADER_PY,
      "loader/requirements.txt": "requests>=2.31\n",
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: load_openaddresses",
        "      file: loader/load_openaddresses.py",
        '      args: ["northeast"]',
        "      requirements: loader/requirements.txt",
        '      pythonVersion: ">=3.11"',
        "      venv: .venv",
        '      tags: ["ingest"]'
      ].join("\n")
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    expect(graph.scripts.length).equals(1);
    const script = graph.scripts[0];
    expect(script.target.name).equals("load_openaddresses");
    expect(script.language).equals("python");
    expect(script.scriptFilename).equals("loader/load_openaddresses.py");
    expect(script.args).deep.equals(["northeast"]);
    expect(script.depsFile).equals("loader/requirements.txt");
    expect(script.runtimeVersion).equals(">=3.11");
    expect(script.envRoot).equals(".venv");
    expect(script.tags).deep.equals(["ingest"]);
    // Scripts read/write arbitrary files: always NON_HERMETIC (enum value 2).
    expect(script.hermeticity).equals(2);
  });

  test("plain-string dependencies map to dependencyTargets", () => {
    const graph = compileProject({
      "loader/a.py": LOADER_PY,
      "loader/b.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: step_a",
        "      file: loader/a.py",
        "  - python:",
        "      name: step_b",
        "      file: loader/b.py",
        '      dependencies: ["step_a"]'
      ].join("\n")
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const stepB = graph.scripts.find((s: any) => s.target.name === "step_b");
    expect(stepB.dependencyTargets.map((t: any) => t.name)).deep.equals(["step_a"]);
  });

  test("a downstream import action can depend on a script", () => {
    const graph = compileProject({
      "loader/load.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: stage_files",
        "      file: loader/load.py"
      ].join("\n"),
      "definitions/orders_in.sqlx":
        `config { type: "import", dependencyTargets: [{name: "stage_files"}], ` +
        `import: { location: "gs://b/orders/*.parquet", format: "parquet" } }`
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    const imp = graph.imports[0];
    expect(imp.dependencyTargets.map((t: any) => t.name)).contains("stage_files");
  });

  test("generic script: form (no sugar) also works", () => {
    const graph = compileProject({
      "loader/load.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - script:",
        '      language: "python"',
        "      name: stage_files",
        "      filename: loader/load.py"
      ].join("\n")
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    expect(graph.scripts.length).equals(1);
    expect(graph.scripts[0].language).equals("python");
  });

  test("name defaults to the script file basename", () => {
    const graph = compileProject({
      "loader/load_openaddresses.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      file: loader/load_openaddresses.py"
      ].join("\n")
    });
    expect(graph.graphErrors.compilationErrors).deep.equals([]);
    expect(graph.scripts[0].target.name).equals("load_openaddresses");
  });

  test("rejects a script file missing from the project", () => {
    const graph = compileProject({
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: load",
        "      file: loader/missing.py"
      ].join("\n")
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Script file not found in the project");
  });

  test("rejects a requirements file missing from the project", () => {
    const graph = compileProject({
      "loader/load.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: load",
        "      file: loader/load.py",
        "      requirements: loader/missing_requirements.txt"
      ].join("\n")
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Script requirements file not found in the project");
  });

  test("rejects a malformed pythonVersion specifier", () => {
    const graph = compileProject({
      "loader/load.py": LOADER_PY,
      "definitions/actions.yaml": [
        "actions:",
        "  - python:",
        "      name: load",
        "      file: loader/load.py",
        '      pythonVersion: "3.11 or newer"'
      ].join("\n")
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Malformed runtime version specifier");
  });

  test("rejects an unsupported script language", () => {
    const graph = compileProject({
      "loader/load.rb": "puts 'hi'\n",
      "definitions/actions.yaml": [
        "actions:",
        "  - script:",
        '      language: "ruby"',
        "      name: load",
        "      filename: loader/load.rb"
      ].join("\n")
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("Unsupported script language");
  });

  test("requires a script file", () => {
    const graph = compileProject({
      "definitions/actions.yaml": ["actions:", "  - python:", "      name: load"].join("\n")
    });
    const errors = JSON.stringify(graph.graphErrors.compilationErrors);
    expect(errors).contains("require a `file`");
  });
});
