// Release area: the package tarballs, their manifests and their bundles
// (FR-025 to FR-029, FR-031, FR-032, FR-035; test-cases/release.yaml).

import { expect } from "chai";
import * as fs from "fs";
import * as nodeModule from "module";
import * as path from "path";

import { nodePath, suite, test } from "sa/testing";
import { fileLines, licenseHeader, run, runfile, source, versions, withTemp, writeFile } from "./helpers";
import { KnownFailure, strictKnownFailure } from "./known_failing";
import { CLI_TAR, CORE_TAR, entry, extractTarGz, manifest, readTarGz, SAMPLE_TAR } from "./tar";

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function entryText(tar: string, name: string): string {
  return entry(readTarGz(runfile(tar)), name).data.toString("utf8");
}

suite("release tarballs", () => {
  test("@prd T-025.1 the CLI tarball holds exactly the six package entries", async () => {
    const names = readTarGz(runfile(CLI_TAR))
      .map((e) => e.name)
      .sort(byteOrder);
    expect(names).deep.equals([
      "package/LICENSE",
      "package/NOTICE",
      "package/README.md",
      "package/bundle.js",
      "package/package.json",
      "package/worker_bundle.js",
    ]);
  });

  test("@prd T-025.2 the CLI and core tarballs hold regular-file entries only", async () => {
    for (const tar of [CLI_TAR, CORE_TAR]) {
      const entries = readTarGz(runfile(tar));
      const notRegular = entries.filter((e) => e.type !== "0").map((e) => `${e.name} (type ${e.type})`);
      const endingInSlash = entries.filter((e) => e.name.endsWith("/")).map((e) => e.name);
      const dotUnderscore = entries.filter((e) => path.posix.basename(e.name).startsWith("._")).map((e) => e.name);
      expect(notRegular, `${tar}: every_entry_is_regular_file`).deep.equals([]);
      expect(endingInSlash.length, `${tar}: entries_ending_in_slash ${endingInSlash.join(", ")}`).equals(0);
      expect(
        dotUnderscore.length,
        `${tar}: entries_whose_base_name_starts_with_dot_underscore ${dotUnderscore.join(", ")}`,
      ).equals(0);
    }
  });

  test("@prd T-025.3 the CLI tarball copies cli/README.md, LICENSE and NOTICE byte for byte", async () => {
    const entries = readTarGz(runfile(CLI_TAR));
    const pairs: Array<[string, string]> = [
      ["package/README.md", "cli/README.md"],
      ["package/LICENSE", "LICENSE"],
      ["package/NOTICE", "NOTICE"],
    ];
    for (const [name, file] of pairs) {
      const expected = fs.readFileSync(source(file));
      expect(Buffer.compare(entry(entries, name).data, expected), `${name} identical to ${file}`).equals(0);
    }
  });

  test("@prd T-026.1 the core tarball contains each listed entry", async () => {
    const names = readTarGz(runfile(CORE_TAR)).map((e) => e.name);
    for (const name of [
      "package/bundle.js",
      "package/bundle.d.ts",
      "package/configs.proto",
      "package/core.proto",
      "package/db_adapter.proto",
      "package/extension.proto",
      "package/jit.proto",
      "package/LICENSE",
      "package/NOTICE",
      "package/package.json",
      "package/README.md",
    ]) {
      expect(names, `contains ${name}`).to.include(name);
    }
  });

  test("@prd T-026.2 the core protos carry the license header; README, LICENSE and NOTICE are copied", async () => {
    const entries = readTarGz(runfile(CORE_TAR));
    const header = licenseHeader();
    for (const proto of ["configs", "core", "db_adapter", "extension", "jit"]) {
      const expected = Buffer.concat([
        Buffer.from(header.join("\n") + "\n\n", "utf8"),
        fs.readFileSync(source(`protos/${proto}.proto`)),
      ]);
      expect(
        Buffer.compare(entry(entries, `package/${proto}.proto`).data, expected),
        `package/${proto}.proto equals HEADER, an empty line and protos/${proto}.proto`,
      ).equals(0);
    }
    const pairs: Array<[string, string]> = [
      ["package/README.md", "README.md"],
      ["package/LICENSE", "LICENSE"],
      ["package/NOTICE", "NOTICE"],
    ];
    for (const [name, file] of pairs) {
      const expected = fs.readFileSync(source(file));
      expect(Buffer.compare(entry(entries, name).data, expected), `${name} identical to ${file}`).equals(0);
    }
  });

  test("@prd T-027.1 the CLI manifest's name, version, description, main, bin and engines", async () => {
    const m = manifest(runfile(CLI_TAR));
    expect(m.name).equals("@sqlanvil/cli");
    expect(m.version).equals(versions().sv);
    expect(m.description).equals("sqlanvil command line interface.");
    expect(m.main).equals("bundle.js");
    expect(m.bin).deep.equals({ sqlanvil: "bundle.js" });
    expect(m.engines).deep.equals({ node: "^20.19.0 || >=22.12.0" });
  });

  test("@prd T-027.2 the CLI manifest's dependencies are the 25 externals at the root ranges", async () => {
    const m = manifest(runfile(CLI_TAR));
    const root = JSON.parse(fs.readFileSync(source("package.json"), "utf8"));
    const deps = m.dependencies || {};
    expect(Object.keys(deps).sort()).deep.equals([
      "@duckdb/node-api",
      "@google-cloud/bigquery",
      "chokidar",
      "fs-extra",
      "glob",
      "google-auth-library",
      "google-sql-syntax-ts",
      "ignore",
      "js-beautify",
      "js-yaml",
      "long",
      "moo",
      "mysql2",
      "object-sizeof",
      "parse-duration",
      "pg",
      "pg-query-stream",
      "promise-pool-executor",
      "protobufjs",
      "readline-sync",
      "semver",
      "tmp",
      "typeid-js",
      "untildify",
      "yargs",
    ]);
    for (const key of Object.keys(deps)) {
      expect(deps[key], `dependencies["${key}"]`).equals((root.dependencies || {})[key]);
    }
  });

  test("@prd T-027.3 the CLI manifest has no devDependencies, packageManager or pnpm key", async () => {
    const m = manifest(runfile(CLI_TAR));
    for (const key of ["devDependencies", "packageManager", "pnpm"]) {
      expect(Object.prototype.hasOwnProperty.call(m, key), `${key} absent`).equals(false);
    }
  });

  test("@prd T-027.4 the CLI manifest's dependency names are the packages the bundles require", async () => {
    const entries = readTarGz(runfile(CLI_TAR));
    const builtins = new Set(nodeModule.builtinModules);
    const isBuiltin = (s: string) => {
      const bare = s.startsWith("node:") ? s.substring(5) : s;
      return builtins.has(s) || builtins.has(bare) || builtins.has(`node:${bare}`);
    };
    const names = new Set<string>();
    for (const file of ["package/bundle.js", "package/worker_bundle.js"]) {
      const text = entry(entries, file).data.toString("utf8");
      const re = /\b(?:require|nativeRequire\)?)\(["']([^"']+)["']\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const s = match[1];
        if (s.startsWith(".") || path.isAbsolute(s) || isBuiltin(s) || s === "@sqlanvil/core") {
          continue;
        }
        // A scoped S counts as its first two path segments, any other S as its first one.
        const segments = s.split("/");
        names.add(s.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]);
      }
    }
    const m = manifest(runfile(CLI_TAR));
    expect(Object.keys(m.dependencies || {}).sort(), "sorted_dependency_names").deep.equals([...names].sort());
  });

  test("@prd T-028.1 the core manifest's name, version, description, main and dependencies", async () => {
    const m = manifest(runfile(CORE_TAR));
    expect(m.name).equals("@sqlanvil/core");
    expect(m.version).equals(versions().sv);
    expect(m.description).equals("sqlanvil core API.");
    expect(m.main).equals("bundle.js");
    expect(m.dependencies).deep.equals({});
  });

  test("@prd T-028.2 the core manifest has no bin, engines, types, devDependencies, packageManager or pnpm key", async () => {
    const m = manifest(runfile(CORE_TAR));
    for (const key of ["bin", "engines", "types", "devDependencies", "packageManager", "pnpm"]) {
      expect(Object.prototype.hasOwnProperty.call(m, key), `${key} absent`).equals(false);
    }
  });

  test("@prd T-029.1 known-failing E-018 every package manifest carries the shared npm metadata", async () => {
    await strictKnownFailure("E-018", async () => {
      const tars = [CLI_TAR, CORE_TAR, SAMPLE_TAR];
      const manifests = tars.map((tar) => manifest(runfile(tar)));
      // The symptom, a state: the manifests' keywords end at "dataops", without the four.
      const missing = ["postgres", "postgresql", "supabase", "mysql"];
      const symptomSeen = manifests.every(
        (m) =>
          Array.isArray(m.keywords) &&
          m.keywords[m.keywords.length - 1] === "dataops" &&
          missing.every((k) => !m.keywords.includes(k)),
      );
      if (symptomSeen) {
        throw new KnownFailure(
          "E-018",
          'the manifests\' keywords end at "dataops", without postgres, postgresql, supabase and mysql',
        );
      }
      for (let i = 0; i < tars.length; i++) {
        expectSharedMetadata(tars[i], manifests[i]);
      }
    });
  });

  function expectSharedMetadata(tar: string, m: any) {
    expect(m.homepage, `${tar} homepage`).equals("https://sqlanvil.com");
    expect(m.repository, `${tar} repository`).deep.equals({
      type: "git",
      url: "git+https://github.com/sqlanvil/sqlanvil.git",
    });
    expect(m.bugs, `${tar} bugs`).deep.equals({ url: "https://github.com/sqlanvil/sqlanvil/issues" });
    expect(m.license, `${tar} license`).equals("Apache-2.0");
    expect(m.keywords, `${tar} keywords`).deep.equals([
      "sqlanvil",
      "etl",
      "data-pipeline",
      "big-data",
      "data-modelling",
      "sql",
      "bigquery",
      "dataops",
      "postgres",
      "postgresql",
      "supabase",
      "mysql",
    ]);
    expect(m.publishConfig, `${tar} publishConfig`).deep.equals({ access: "public" });
  }

  test("@prd T-031.1 the CLI bundles start with a shebang, the license header and an empty line", async () => {
    const header = licenseHeader();
    for (const file of ["package/bundle.js", "package/worker_bundle.js"]) {
      const lines = fileLines(entryText(CLI_TAR, file));
      expect(lines[0], `${file} line 1`).equals("#!/usr/bin/env node");
      expect(lines.slice(1, 14), `${file} lines 2 to 14`).deep.equals(header);
      expect(lines[14], `${file} line 15`).equals("");
    }
  });

  test("@prd T-031.2 the CLI bundles inline sa/ modules and keep externals as run-time requires", async () => {
    const bundle = entryText(CLI_TAR, "package/bundle.js");
    const worker = entryText(CLI_TAR, "package/worker_bundle.js");
    const saRequire = /\brequire\(\s*["']sa\/[^"']*["']\s*\)/g;
    expect((bundle.match(saRequire) || []).length, "require of sa/ in bundle.js").equals(0);
    expect((worker.match(saRequire) || []).length, "require of sa/ in worker_bundle.js").equals(0);
    expect(
      bundle.includes("require('yargs')") || bundle.includes('require("yargs")'),
      "bundle.js contains require('yargs') or require(\"yargs\")",
    ).equals(true);
    expect(worker).to.include('require("@sqlanvil/core")');
  });

  test("@prd T-031.4 bundle.js keeps the nativeRequire call for @duckdb/node-api", async () => {
    expect(entryText(CLI_TAR, "package/bundle.js")).to.include('nativeRequire)("@duckdb/node-api")');
  });

  test("@prd T-032.1 the core bundle starts with the license header and an empty line", async () => {
    const lines = fileLines(entryText(CORE_TAR, "package/bundle.js"));
    expect(lines.slice(0, 13), "lines 1 to 13").deep.equals(licenseHeader());
    expect(lines[13], "line 14").equals("");
  });

  test("@prd T-032.2 the core bundle exports the core API with version SV", async () => {
    await withTemp(async (T) => {
      extractTarGz(runfile(CORE_TAR), path.join(T, "core"));
      const child = path.join(T, "child.js");
      writeFile(
        child,
        [
          "const m = require(process.argv[2]);",
          "process.stdout.write(JSON.stringify({ keys: Object.keys(m), version: m.version }));",
        ].join("\n"),
      );
      const result = await run(nodePath, [child, path.join(T, "core", "package", "bundle.js")], { cwd: T });
      expect(result.exitCode, result.stderr).equals(0);
      const out = JSON.parse(result.stdout);
      for (const key of ["compiler", "indexFileGenerator", "jitCompiler", "main", "session", "supportedFeatures", "version"]) {
        expect(out.keys, `has key ${key}`).to.include(key);
      }
      expect(out.version).equals(versions().sv);
    });
  });

  test("@prd T-032.3 the core bundle.d.ts imports only long and protobufjs", async () => {
    const text = entryText(CORE_TAR, "package/bundle.d.ts");
    const re = /^(?:import|export)\s+(?:.*?\s+from\s+)?["']([^"']+)["'];?$/gm;
    const specifiers = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      specifiers.add(match[1]);
    }
    expect([...specifiers].sort()).deep.equals(["long", "protobufjs"]);
  });

  test("@prd T-035.4 the sample-extension manifest", async () => {
    const m = manifest(runfile(SAMPLE_TAR));
    expect(m.name).equals("@sqlanvil/sample-extension");
    expect(m.version).equals(versions().sv);
    expect(m.description).equals("Sample extension.");
    expect(m.main).equals("bundle.js");
    expect(m.dependencies).deep.equals({});
  });

  test("@prd T-035.5 the sample-extension tarball contains its bundle, declarations and manifest", async () => {
    const names = readTarGz(runfile(SAMPLE_TAR)).map((e) => e.name);
    for (const name of ["package/bundle.js", "package/bundle.d.ts", "package/package.json"]) {
      expect(names, `contains ${name}`).to.include(name);
    }
  });
});
