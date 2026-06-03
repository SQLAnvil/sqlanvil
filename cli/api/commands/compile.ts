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
  compileConfig: sqlanvil.ICompileConfig = {}
): Promise<sqlanvil.CompiledGraph> {
  let compiledGraph = sqlanvil.CompiledGraph.create();

  const resolvedProjectPath = path.resolve(compileConfig.projectDir);
  const packageJsonPath = path.join(resolvedProjectPath, "package.json");
  const packageLockJsonPath = path.join(resolvedProjectPath, "package-lock.json");
  const projectNodeModulesPath = path.join(resolvedProjectPath, "node_modules");

  const temporaryProjectPath = tmp.dirSync().name;

  const workflowSettings = readConfigFromWorkflowSettings(resolvedProjectPath);
  const workflowSettingssqlanvilCoreVersion = workflowSettings?.sqlanvilCoreVersion;
  const workflowSettingsExtension = workflowSettings?.extension ?? undefined;

  compileConfig.extension = workflowSettingsExtension;

  if (!workflowSettingssqlanvilCoreVersion && !fs.existsSync(packageJsonPath)) {
    throw new Error(MISSING_CORE_VERSION_ERROR);
  }

  // For stateless package installation, a temporary directory is used in order to avoid interfering
  // with user's project directories.
  if (workflowSettingssqlanvilCoreVersion) {
    [projectNodeModulesPath, packageJsonPath, packageLockJsonPath].forEach(npmPath => {
      if (fs.existsSync(npmPath)) {
        throw new Error(`'${npmPath}' unexpected; remove it and try again`);
      }
    });

    if (compileConfig.verbose) {
      print(`Using isolated environment for @sqlanvil/core@${workflowSettingssqlanvilCoreVersion}\n`);
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
  "@sqlanvil/core": "${workflowSettingssqlanvilCoreVersion}"
  }
}`
    );

    const npmCommand = `npm i --ignore-scripts${compileConfig.verbose ? " --loglevel=http" : ""}`;
    if (compileConfig.verbose) {
      print(`Running '${npmCommand}' in temporary directory...\n`);
    }
    const npmStartTime = performance.now();
    const { stdout, stderr } = await promisify(exec)(npmCommand, {
      cwd: temporaryProjectPath
    });

    if (compileConfig.verbose) {
      print(`NPM HTTP Logs:\n${stderr}\n`);
      print(`NPM install completed in ${performance.now() - npmStartTime}ms\n`);
    }

    compileConfig.projectDir = temporaryProjectPath;
  }

  const result = await new CompileChildProcess().compile(compileConfig);

  const decodedResult = decode64(sqlanvil.CoreExecutionResponse, result);
  compiledGraph = sqlanvil.CompiledGraph.create(decodedResult.compile.compiledGraph);

  if (workflowSettingssqlanvilCoreVersion) {
    fs.rmSync(temporaryProjectPath, { recursive: true });
  }

  return compiledGraph;
}

export class CompileChildProcess extends BaseWorker<string, string | Error> {
  constructor() {
    super(path.resolve(__dirname, "../../vm/compile_loader"));
  }

  public async compile(compileConfig: sqlanvil.ICompileConfig) {
    const timeoutValue = compileConfig.timeoutMillis || DEFAULT_COMPILATION_TIMEOUT_MILLIS;

    return await this.runWorker(
      timeoutValue,
      child => child.send(compileConfig),
      (message, child, resolve, reject) => {
        if (typeof message === "string") {
          resolve(message);
          return;
        }
        reject(coerceAsError(message));
      }
    );
  }
}
