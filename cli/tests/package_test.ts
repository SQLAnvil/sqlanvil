import { expect } from "chai";
import * as fs from "fs";
import { builtinModules } from "module";
import * as path from "path";

import { cliEntryPointPath } from "sa/cli/index_test_base";
import { suite, test } from "sa/testing";

// Upstream #2457 / #2469: @sqlanvil/cli declares exactly the external packages its bundles
// require, and none of the workspace's package.json fields.
const PACKAGED_CLI_DIR = path.dirname(cliEntryPointPath);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function toPackageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function extractExternalPackageRequires(bundleContents: string): string[] {
  // sqlanvil loads the DuckDB native addon through nativeRequire(), which rollup leaves alone and
  // TypeScript emits as `(0, utils_1.nativeRequire)("...")`.
  const requireRegex = /\b(?:require|nativeRequire\)?)\(["']([^"']+)["']\)/g;
  const packages = new Set<string>();
  let match = requireRegex.exec(bundleContents);
  while (match !== null) {
    const specifier = match[1];
    if (
      !specifier.startsWith(".") &&
      !path.isAbsolute(specifier) &&
      !NODE_BUILTINS.has(specifier) &&
      specifier !== "@sqlanvil/core"
    ) {
      packages.add(toPackageName(specifier));
    }
    match = requireRegex.exec(bundleContents);
  }
  return Array.from(packages).sort();
}

suite("@sqlanvil/cli package", () => {
  test("package.json dependencies match external packages required by CLI bundles", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGED_CLI_DIR, "package.json"), "utf8"),
    ) as Record<string, unknown> & { dependencies: Record<string, string> };
    const mainBundle = fs.readFileSync(cliEntryPointPath, "utf8");
    const workerBundle = fs.readFileSync(path.join(PACKAGED_CLI_DIR, "worker_bundle.js"), "utf8");

    const requiredPackages = Array.from(
      new Set([
        ...extractExternalPackageRequires(mainBundle),
        ...extractExternalPackageRequires(workerBundle),
      ]),
    ).sort();
    const declaredDependencies = Object.keys(packageJson.dependencies).sort();

    expect(declaredDependencies).to.deep.equal(requiredPackages);
    expect(packageJson).to.not.have.property("devDependencies");
    expect(packageJson).to.not.have.property("pnpm");
    expect(packageJson).to.not.have.property("packageManager");
  });
});
