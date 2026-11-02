import { exec } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import * as tmp from "tmp";
import { promisify } from "util";

import { BaseWorker } from "sa/cli/api/commands/base_worker";
import { MISSING_CORE_VERSION_ERROR } from "sa/cli/api/commands/install";
import { readConfigFromWorkflowSettings } from "sa/cli/api/utils";
import { DEFAULT_COMPILATION_TIMEOUT_MILLIS } from "sa/cli/api/utils/constants";
import { coerceAsError } from "sa/common/errors/errors";
import { decode64 } from "sa/common/protos";
import { sqlanvil } from "sa/protos/ts";

export class CompilationTimeoutError extends Error {}

function print(text: string) {
  process.stderr.write(text);
}

export async function compile(
  compileConfig: sqlanvil.ICompileConfig = {},
): Promise<sqlanvil.CompiledGraph> {
  let compiledGraph = sqlanvil.CompiledGraph.create();

  const resolvedProjectPath = path.resolve(compileConfig.projectDir);
  const packageJsonPath = path.join(resolvedProjectPath, "package.json");
  const packageLockJsonPath = path.join(resolvedProjectPath, "package-lock.json");
  const projectNodeModulesPath = path.join(resolvedProjectPath, "node_modules");

  const workflowSettings = readConfigFromWorkflowSettings(resolvedProjectPath);
  const workflowSettingsSqlanvilCoreVersion = workflowSettings?.sqlanvilCoreVersion;
  const workflowSettingsExtension = workflowSettings?.extension ?? undefined;

  compileConfig.extension = workflowSettingsExtension;

  if (!workflowSettingsSqlanvilCoreVersion && !fs.existsSync(packageJsonPath)) {
    throw new Error(MISSING_CORE_VERSION_ERROR);
  }

  if (workflowSettingsSqlanvilCoreVersion) {
    [projectNodeModulesPath, packageJsonPath, packageLockJsonPath].forEach((npmPath) => {
      if (fs.existsSync(npmPath)) {
        throw new Error(`'${npmPath}' unexpected; remove it and try again`);
      }
    });
  }

  // For stateless package installation, a temporary directory is used in order to avoid interfering
  // with user's project directories. It is created only for projects that pin sqlanvilCoreVersion
  // (a package.json project compiles in place) and removed on every path, including a failed
  // install or compile (upstream #2392; before, a package.json project leaked an empty directory
  // per compile and a failed compile leaked the whole project copy).
  const temporaryProjectPath = workflowSettingsSqlanvilCoreVersion ? tmp.dirSync().name : undefined;

  try {
    if (temporaryProjectPath) {
      await installIsolatedCore(
        compileConfig,
        resolvedProjectPath,
        temporaryProjectPath,
        workflowSettingsSqlanvilCoreVersion,
      );
      compileConfig.projectDir = temporaryProjectPath;
    }

    const result = await new CompileChildProcess().compile(compileConfig);

    const decodedResult = decode64(sqlanvil.CoreExecutionResponse, result);
    compiledGraph = sqlanvil.CompiledGraph.create(decodedResult.compile.compiledGraph);
  } finally {
    if (temporaryProjectPath) {
      // fs-extra's removeSync, not node's fs.rmSync. Node's recursive rm goes through its
      // internal rimraf, which hands a Buffer path to readdirSync; the rules_nodejs 3.8.0
      // node_patches shim that `bazel run` used to inject only handled strings, so every
      // `./scripts/run compile` of a project pinning sqlanvilCoreVersion died on cleanup.
      // fs-extra uses its own vendored rimraf and passes strings throughout.
      fs.removeSync(temporaryProjectPath);
    }
  }

  return compiledGraph;
}

async function installIsolatedCore(
  compileConfig: sqlanvil.ICompileConfig,
  resolvedProjectPath: string,
  temporaryProjectPath: string,
  coreVersion: string,
) {
  if (compileConfig.verbose) {
    print(`Using isolated environment for @sqlanvil/core@${coreVersion}\n`);
    print(`Copying project to temporary directory: ${temporaryProjectPath}\n`);
  }
  const copyStartTime = performance.now();
  fs.copySync(resolvedProjectPath, temporaryProjectPath);
  if (compileConfig.verbose) {
    print(`Project copy completed in ${performance.now() - copyStartTime}ms\n`);
  }

  if (compileConfig.verbose) {
    print(`Generating temporary package.json\n`);
  }
  fs.writeFileSync(
    path.join(temporaryProjectPath, "package.json"),
    `{
  "dependencies": {
  "@sqlanvil/core": "${coreVersion}"
  }
}`,
  );

  const npmCommand = `npm i --ignore-scripts${compileConfig.verbose ? " --loglevel=http" : ""}`;
  if (compileConfig.verbose) {
    print(`Running '${npmCommand}' in temporary directory...\n`);
  }
  const npmStartTime = performance.now();
  let stderr: string;
  try {
    ({ stderr } = await promisify(exec)(npmCommand, {
      cwd: temporaryProjectPath,
    }));
  } catch (e) {
    throw new Error(`Failed to install @sqlanvil/core@${coreVersion}: ${coerceAsError(e).message}`);
  }

  if (compileConfig.verbose) {
    print(`NPM HTTP Logs:\n${stderr}\n`);
    print(`NPM install completed in ${performance.now() - npmStartTime}ms\n`);
  }
}

export class CompileChildProcess extends BaseWorker<string, string | Error> {
  public async compile(compileConfig: sqlanvil.ICompileConfig) {
    const timeoutValue = compileConfig.timeoutMillis || DEFAULT_COMPILATION_TIMEOUT_MILLIS;

    return await this.runWorker(
      timeoutValue,
      (child) => child.send(compileConfig),
      (message, child, resolve, reject) => {
        if (typeof message === "string") {
          resolve(message);
          return;
        }
        reject(coerceAsError(message));
      },
    );
  }
}
