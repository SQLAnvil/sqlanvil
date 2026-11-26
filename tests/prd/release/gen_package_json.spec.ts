// Release area: the package manifest generator, //packages:gen-package-json-bin
// (FR-030; test-cases/release.yaml T-030.1 to T-030.8).

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import { binary, childEnv, ProcessResult, run, withTemp, writeFile } from "./helpers";
import { KnownFailure, strictKnownFailure } from "./known_failing";

async function generate(T: string, argv: string[]): Promise<ProcessResult> {
  // T in an argv entry stands for the case's temporary directory.
  const args = argv.map((a) => (a.startsWith("T/") ? path.join(T, a.substring(2)) : a));
  return run(binary("packages", "gen-package-json-bin"), args, {
    cwd: T,
    env: childEnv({ BAZEL_BINDIR: "." }),
  });
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Reads the generator's output file, saying how the generator exited when it wrote none. */
function readOutput(T: string, name: string, r: ProcessResult): any {
  const file = path.join(T, name);
  expect(fs.existsSync(file), `T/${name} was written (exit ${r.exitCode}: ${r.stderr})`).equals(true);
  return readJson(file);
}

function has(o: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

suite("release gen-package-json-bin", () => {
  test("@prd T-030.1 layers merge in order, a later value wins, keys keep first appearance", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"a":1,"dependencies":{"x":"^1.0.0"}}');
      writeFile(path.join(T, "l2.json"), '{"a":2,"b":3}');
      const r = await generate(T, [
        "--name", "@t/p",
        "--description", "d",
        "--package-version", "9.9.9",
        "--main", "bundle.js",
        "--output-path", "T/out.json",
        "--layer-paths", "T/l1.json", "T/l2.json",
        "--external-dependencies", "x",
      ]);
      expect(r.exitCode, r.stderr).equals(0);
      expect(fs.existsSync(path.join(T, "out.json")), "file exists: T/out.json").equals(true);
      const out = readJson(path.join(T, "out.json"));
      expect(out).deep.equals({
        a: 2,
        dependencies: { x: "^1.0.0" },
        b: 3,
        version: "9.9.9",
        name: "@t/p",
        description: "d",
        main: "bundle.js",
      });
      expect(Object.keys(out)).deep.equals(["a", "dependencies", "b", "version", "name", "description", "main"]);
    });
  });

  test("@prd T-030.2 version, name and description replace the layer values", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"name":"old","version":"0.0.1","description":"old","dependencies":{}}');
      const r = await generate(T, [
        "--name", "@t/new",
        "--description", "new desc",
        "--package-version", "2.3.4",
        "--output-path", "T/out.json",
        "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      const out = readOutput(T, "out.json", r);
      expect(out.name).equals("@t/new");
      expect(out.version).equals("2.3.4");
      expect(out.description).equals("new desc");
    });
  });

  test("@prd T-030.3 main and types are set only when non-empty", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"main":"layer.js","dependencies":{}}');
      const empty = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--main", "", "--types", "",
        "--output-path", "T/a.json", "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      const given = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--main", "m.js", "--types", "m.d.ts",
        "--output-path", "T/b.json", "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      const a = readOutput(T, "a.json", empty);
      expect(a.main, "empty: main").equals("layer.js");
      expect(has(a, "types"), "empty: types absent").equals(false);
      const b = readOutput(T, "b.json", given);
      expect(b.main, "given: main").equals("m.js");
      expect(b.types, "given: types").equals("m.d.ts");
    });
  });

  test("@prd T-030.4 devDependencies, packageManager and pnpm are removed", async () => {
    await withTemp(async (T) => {
      writeFile(
        path.join(T, "l1.json"),
        '{"dependencies":{},"devDependencies":{"z":"1"},"packageManager":"example-pm","pnpm":{"overrides":{}}}',
      );
      const r = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--output-path", "T/out.json", "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      const out = readOutput(T, "out.json", r);
      for (const key of ["devDependencies", "packageManager", "pnpm"]) {
        expect(has(out, key), `${key} absent`).equals(false);
      }
    });
  });

  test("@prd T-030.5 dependencies hold only the named externals, in the order named", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"dependencies":{"x":"^1.0.0","y":"~2.0.0","z":"3.0.0"}}');
      const listed = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--output-path", "T/a.json", "--layer-paths", "T/l1.json",
        "--external-dependencies", "z", "x",
      ]);
      expect(listed.exitCode, `listed: ${listed.stderr}`).equals(0);
      const none = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--output-path", "T/b.json", "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      expect(none.exitCode, `none: ${none.stderr}`).equals(0);
      const a = readJson(path.join(T, "a.json"));
      expect(a.dependencies, "listed: dependencies").deep.equals({ z: "3.0.0", x: "^1.0.0" });
      expect(Object.keys(a.dependencies), "listed: dependency_key_order").deep.equals(["z", "x"]);
      const b = readJson(path.join(T, "b.json"));
      expect(b.dependencies, "none: dependencies").deep.equals({});
    });
  });

  test("@prd T-030.6 the output is JSON indented with 4 spaces and no final newline", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"dependencies":{}}');
      const r = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--output-path", "T/out.json", "--layer-paths", "T/l1.json",
        "--external-dependencies",
      ]);
      const outPath = path.join(T, "out.json");
      expect(fs.existsSync(outPath), `T/out.json was written (exit ${r.exitCode}: ${r.stderr})`).equals(true);
      const text = fs.readFileSync(outPath, "utf8");
      expect(text).equals(
        '{\n    "dependencies": {},\n    "version": "1.0.0",\n    "name": "n",\n    "description": "d"\n}',
      );
      expect(text.endsWith("}"), "T/out.json ends with '}' and no newline").equals(true);
    });
  });

  test("@prd T-030.7 an external missing from the layers' dependencies fails with the named error", async () => {
    await withTemp(async (T) => {
      writeFile(path.join(T, "l1.json"), '{"dependencies":{"x":"^1.0.0"}}');
      const r = await generate(T, [
        "--name", "n", "--description", "d", "--package-version", "1.0.0",
        "--output-path", "T/out.json", "--layer-paths", "T/l1.json",
        "--external-dependencies", "x", "q",
      ]);
      expect(r.exitCode, "exit code").not.equals(0);
      expect(r.stderr).to.include("Dependency does not appear to be installed in root package.json: q");
      expect(fs.existsSync(path.join(T, "out.json")), "T/out.json does not exist").equals(false);
    });
  });

  test("@prd T-030.8 known-failing E-017 no layer with a dependencies object and a named external fails with the named error", async () => {
    await strictKnownFailure("E-017", async () => {
      await withTemp(async (T) => {
        writeFile(path.join(T, "l1.json"), '{"name":"x"}');
        const r = await generate(T, [
          "--name", "n", "--description", "d", "--package-version", "1.0.0",
          "--output-path", "T/out.json", "--layer-paths", "T/l1.json",
          "--external-dependencies", "q",
        ]);
        const named = "Dependency does not appear to be installed in root package.json: q";
        // The symptom: a non-zero exit with a TypeError ("Cannot read properties of undefined")
        // instead of the named missing-dependency error.
        if (
          r.exitCode !== 0 &&
          r.stderr.includes("TypeError") &&
          r.stderr.includes("Cannot read properties of undefined") &&
          !r.stderr.includes(named)
        ) {
          throw new KnownFailure(
            "E-017",
            'the generator exits non-zero with a TypeError ("Cannot read properties of undefined") instead of the named missing-dependency error',
          );
        }
        expect(r.exitCode, "exit code").not.equals(0);
        expect(r.stderr).to.include(named);
        expect(fs.existsSync(path.join(T, "out.json")), "T/out.json does not exist").equals(false);
      });
    });
  });
});
