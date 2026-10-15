import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";
import * as semver from "semver";
import { CompilerFunction, NodeVM } from "vm2";

import { encode64 } from "sa/common/protos";
import { sqlanvil } from "sa/protos/ts";

export function compile(compileConfig: sqlanvil.ICompileConfig) {
  compileConfig.projectDir = fs.realpathSync(path.resolve(compileConfig.projectDir));
  const coreBundlePath = path.join(
    compileConfig.projectDir,
    "node_modules",
    "@sqlanvil",
    "core",
    "bundle.js",
  );
  if (!fs.existsSync(coreBundlePath)) {
    throw new Error(
      "Could not find a recent installed version of @sqlanvil/core in the project. Check that " +
        "either `sqlanvilCoreVersion` is specified in `workflow_settings.yaml`, or " +
        "`@sqlanvil/core` is specified in `package.json`. If using `package.json`, then run " +
        "`sqlanvil install`.",
    );
  }

  const vmIndexFileName = path.resolve(path.join(compileConfig.projectDir, "index.js"));

  // Retrieve compiler and version from the resolved @sqlanvil/core. Going
  // through Node's resolver inside the vm covers every install layout
  // (package.json, workflow_settings.yaml, JiT) and matches what the user's
  // code will see. require() caches the bundle so the second call is free.
  const indexGeneratorVm = new NodeVM({
    wrapper: "none",
    require: {
      context: "sandbox",
      root: compileConfig.projectDir,
      external: true,
      builtin: ["path"],
    },
  });
  const compiler: CompilerFunction = indexGeneratorVm.run(
    'return require("@sqlanvil/core").compiler',
    vmIndexFileName,
  );
  const sqlanvilCoreVersion: string = indexGeneratorVm.run(
    'return require("@sqlanvil/core").version || "0.0.0"',
    vmIndexFileName,
  );
  checkCoreCompatibility(sqlanvilCoreVersion, readCliVersion());

  // vm2 strips file paths from V8 CallSite objects inside the sandbox, so
  // getCallerFile() in @sqlanvil/core falls back to `global.__sqlanvil_current_file`
  // (every published @sqlanvil/core reads it; the text patch that backported the
  // fallback into pre-3.0.57 Dataform bundles was removed with the 1.0.0 floor).
  // Track the currently executing file via a host-side stack exposed through
  // sandbox helpers, and expose it as a getter on that global.
  const fileStack: string[] = [];

  // Then use vm2's native compiler integration to apply the compiler to files.
  const userCodeVm = new NodeVM({
    wrapper: "none",
    sandbox: {
      __df_enter: (p: string) => {
        fileStack.push(p);
      },
      __df_exit: () => {
        fileStack.pop();
      },
      __df_current: () => (fileStack.length > 0 ? fileStack[fileStack.length - 1] : null),
    },
    require: {
      builtin: ["path"],
      context: "sandbox",
      external: true,
      root: compileConfig.projectDir,
      resolve: (moduleName, parentDirName) =>
        path.join(
          parentDirName,
          path.relative(parentDirName, compileConfig.projectDir),
          moduleName,
        ),
    },
    sourceExtensions: ["js", "sql", "sqlx", "yaml", "yml"],
    compiler: (code, filePath) => {
      const compiledCode = compiler(code, filePath);
      return `
        __df_enter(${JSON.stringify(filePath)});
        try {
          ${compiledCode}
        } finally {
          __df_exit();
        }
      `;
    },
  });

  const hasWorkflowSettingsYaml = fs.existsSync(
    path.join(compileConfig.projectDir, "workflow_settings.yaml"),
  );

  return userCodeVm.run(
    `
      Object.defineProperty(global, '__sqlanvil_current_file', {
        configurable: true,
        get: function() { return __df_current(); }
      });
      ${
        hasWorkflowSettingsYaml
          ? 'global.workflowSettingsYaml = require("./workflow_settings.yaml");'
          : ""
      }
      return require("@sqlanvil/core").main("${createCoreExecutionRequest(compileConfig)}")
    `,
    vmIndexFileName,
  );
}

export function listenForCompileRequest() {
  process.on("message", (compileConfig: sqlanvil.ICompileConfig & { type?: string }) => {
    // JiT messages are handled by handleJitRequest in worker.ts; skip them here.
    if ((compileConfig as { type?: string })?.type === "jit_compile") {
      return;
    }
    try {
      const compiledResult = compile(compileConfig);
      process.send(compiledResult);
    } catch (e) {
      const serializableError = {};
      for (const prop of Object.getOwnPropertyNames(e)) {
        (serializableError as any)[prop] = e[prop];
      }
      process.send(serializableError);
    }
  });
}

if (require.main === module) {
  if (process.send) {
    process.send({ type: "worker_booted" });
  }
  listenForCompileRequest();
}

// Reads the CLI's own version from the package.json baked next to the bundle
// by pkg_json(version = SQLANVIL_VERSION). Returns "0.0.0" when unreadable.
function readCliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// The oldest @sqlanvil/core this CLI works with. It is deliberately NOT derived from the
// CLI's own version (which used to make every minor bump reject every older core, so a
// 1.33.0 CLI refused a project pinned to 1.32.10). Raise it on purpose only, and update
// cli/vm/compile_test.ts when you do. Everything from 1.0.0 up is built on Dataform
// >= 3.0.59, so no published core needs the old caller-file bundle patch.
export const MIN_SUPPORTED_CORE_VERSION = "1.0.0";

/**
 * Throws if this CLI can't work with the installed @sqlanvil/core. Core must share the
 * CLI's major version and be at least MIN_SUPPORTED_CORE_VERSION; a core newer than the
 * CLI is fine as long as the major matches. (Adapted from upstream dataform #2376.)
 */
export function checkCoreCompatibility(coreVersion: string, cliVersion: string) {
  const cliParsed = semver.parse(cliVersion);
  // Skip the check when the CLI version is unknown or invalid: readCliVersion() returns
  // "0.0.0" when it can't read package.json, e.g. running from source instead of a bundle.
  if (!cliParsed || cliVersion === "0.0.0") {
    return;
  }
  const majorFloor = `${cliParsed.major}.0.0`;
  const minCoreVersion = semver.gt(MIN_SUPPORTED_CORE_VERSION, majorFloor)
    ? MIN_SUPPORTED_CORE_VERSION
    : majorFloor;
  if (semver.major(coreVersion) !== cliParsed.major || semver.lt(coreVersion, minCoreVersion)) {
    throw new Error(
      `@sqlanvil/core ${coreVersion} is not compatible with @sqlanvil/cli ${cliVersion}. ` +
        `The CLI requires @sqlanvil/core >=${minCoreVersion} <${cliParsed.major + 1}.0.0. ` +
        `Set \`sqlanvilCoreVersion: ${cliVersion}\` in workflow_settings.yaml, or pin ` +
        `@sqlanvil/core in package.json and run \`sqlanvil install\`.`,
    );
  }
}

/**
 * @returns a base64 encoded @see {@link sqlanvil.CoreExecutionRequest} proto.
 */
function createCoreExecutionRequest(compileConfig: sqlanvil.ICompileConfig): string {
  const filePaths = Array.from(
    new Set<string>(glob.sync("!(node_modules)/**/*.*", { cwd: compileConfig.projectDir })),
  );

  return encode64(sqlanvil.CoreExecutionRequest, {
    // Add the list of file paths to the compile config if not already set.
    compile: { compileConfig: { filePaths, ...compileConfig } },
  });
}
