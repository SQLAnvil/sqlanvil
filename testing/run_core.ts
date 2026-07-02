// tslint:disable tsr-detect-non-literal-fs-filename
import * as fs from "fs-extra";
import * as path from "path";
import { CompilerFunction, NodeVM } from "vm2";

import { decode64, encode64 } from "sa/common/protos";
import { compile } from "sa/core/compilers";
import { sqlanvil } from "sa/protos/ts";

export const VALID_WORKFLOW_SETTINGS_YAML = `
defaultProject: defaultProject
defaultDataset: defaultDataset
defaultLocation: US
`;

export class WorkflowSettingsTemplates {
  public static bigquery = sqlanvil.WorkflowSettings.create({
    defaultDataset: "defaultDataset",
    defaultLocation: "US"
  });

  public static bigqueryWithDefaultProject = sqlanvil.WorkflowSettings.create({
    ...WorkflowSettingsTemplates.bigquery,
    defaultProject: "defaultProject"
  });

  public static bigqueryWithDatasetSuffix = sqlanvil.WorkflowSettings.create({
    ...WorkflowSettingsTemplates.bigquery,
    datasetSuffix: "suffix"
  });

  public static bigqueryWithDefaultProjectAndDataset = sqlanvil.WorkflowSettings.create({
    ...WorkflowSettingsTemplates.bigqueryWithDefaultProject,
    projectSuffix: "suffix"
  });

  public static bigqueryWithNamePrefix = sqlanvil.WorkflowSettings.create({
    ...WorkflowSettingsTemplates.bigquery,
    namePrefix: "prefix"
  });
}

const SOURCE_EXTENSIONS = ["js", "sql", "sqlx", "yaml", "ipynb","md"];

export function coreExecutionRequestFromPath(
  projectDir: string,
  projectConfigOverride?: sqlanvil.ProjectConfig
): sqlanvil.CoreExecutionRequest {
  const resolvedProjectDir = fs.realpathSync(path.resolve(projectDir));
  return sqlanvil.CoreExecutionRequest.create({
    compile: {
      compileConfig: {
        projectDir: resolvedProjectDir,
        filePaths: walkDirectoryForFilenames(resolvedProjectDir),
        projectConfigOverride
      }
    }
  });
}

// A VM is needed when running main because Node functions like `require` are overridden.
export function runMainInVm(
  coreExecutionRequest: sqlanvil.CoreExecutionRequest
): sqlanvil.CoreExecutionResponse {
  const projectDir = coreExecutionRequest.compile.compileConfig.projectDir;

  // Copy over the build sqlanvil Core that is set up as a node_modules directory.
  fs.copySync(`${process.cwd()}/core/node_modules`, `${projectDir}/node_modules`);

  const compiler = compile as CompilerFunction;
  // Then use vm2's native compiler integration to apply the compiler to files.
  const nodeVm = new NodeVM({
    // Inheriting the console makes console.logs show when tests are running, which is useful for
    // debugging.
    console: "inherit",
    wrapper: "none",
    require: {
      builtin: ["path"],
      context: "sandbox",
      external: true,
      root: projectDir,
      resolve: (moduleName, parentDirName) =>
        path.join(parentDirName, path.relative(parentDirName, projectDir), moduleName)
    },
    sourceExtensions: SOURCE_EXTENSIONS,
    compiler: (code, filePath) => {
      const compiledCode = compiler(code, filePath);
      return `
        var __old_file = global.__sqlanvil_current_file;
        global.__sqlanvil_current_file = ${JSON.stringify(filePath)};
        try {
          ${compiledCode}
        } finally {
          global.__sqlanvil_current_file = __old_file;
        }
      `;
    }
  });

  const encodedCoreExecutionRequest = encode64(sqlanvil.CoreExecutionRequest, coreExecutionRequest);
  const vmIndexFileName = path.resolve(path.join(projectDir, "index.js"));
  const encodedCoreExecutionResponse = nodeVm.run(
    `
      global.workflowSettingsYaml = (function() { try { return require("./workflow_settings.yaml"); } catch(e) { console.error("YAML require failed run_core:", e); } })();
      return require("@sqlanvil/core").main("${encodedCoreExecutionRequest}")
    `,
    vmIndexFileName
  );
  return decode64(sqlanvil.CoreExecutionResponse, encodedCoreExecutionResponse);
}

function walkDirectoryForFilenames(projectDir: string, relativePath: string = ""): string[] {
  let paths: string[] = [];
  fs.readdirSync(path.join(projectDir, relativePath), { withFileTypes: true })
    .filter(directoryEntry => directoryEntry.name !== "node_modules")
    .forEach(directoryEntry => {
      if (directoryEntry.isDirectory()) {
        paths = paths.concat(walkDirectoryForFilenames(projectDir, directoryEntry.name));
        return;
      }
      const fileExtension = directoryEntry.name.split(".").slice(-1)[0];
      if (directoryEntry.isFile() && SOURCE_EXTENSIONS.includes(fileExtension)) {
        paths.push(directoryEntry.name);
      }
    });
  return paths.map(filename => path.join(relativePath, filename));
}
