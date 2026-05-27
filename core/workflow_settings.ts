import { YAMLException } from "js-yaml";

import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { INVALID_YAML_ERROR_STRING } from "sa/core/compilers";
import { version } from "sa/core/version";
import { sqlanvil } from "sa/protos/ts";

declare var __webpack_require__: any;
declare var __non_webpack_require__: any;
const nativeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

export function readWorkflowSettings(failIfMissing: boolean = true): sqlanvil.ProjectConfig {
  const globalAny = global as any;
  const workflowSettingsYaml = globalAny.workflowSettingsYaml || maybeRequire("workflow_settings.yaml");

  if (workflowSettingsYaml) {
    const workflowSettingsAsJson = workflowSettingsYaml.asJson;
    if (!workflowSettingsAsJson) {
      throw Error("workflow_settings.yaml is invalid");
    }
    return workflowSettingsAsProjectConfig(verifyWorkflowSettingsAsJson(workflowSettingsAsJson));
  }

  if (failIfMissing) {
    throw Error("Failed to resolve workflow_settings.yaml");
  }
  return sqlanvil.ProjectConfig.create();
}

function verifyWorkflowSettingsAsJson(workflowSettingsAsJson: object): sqlanvil.WorkflowSettings {
  let workflowSettings = sqlanvil.WorkflowSettings.create();
  try {
    workflowSettings = sqlanvil.WorkflowSettings.create(
      verifyObjectMatchesProto(
        sqlanvil.WorkflowSettings,
        workflowSettingsAsJson as {
          [key: string]: any;
        },
        VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
      )
    );
  } catch (e) {
    if (e instanceof ReferenceError) {
      throw ReferenceError(`Workflow settings error: ${e.message}`);
    }
    throw e;
  }

  // The caller of Dataform Core should ensure that the correct version is installed.
  if (!!workflowSettings.sqlanvilCoreVersion && workflowSettings.sqlanvilCoreVersion !== version) {
    throw Error(
      `Version mismatch: workflow settings specifies version ${workflowSettings.sqlanvilCoreVersion}` +
        `, but ${version} was found`
    );
  }

  return workflowSettings;
}

function maybeRequire(file: string): any {
  try {
    // tslint:disable-next-line: tsr-detect-non-literal-require
    return nativeRequire(file);
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof YAMLException) {
      throw e;
    }
    // The YAMLException type isn't propogated by `require`, so instead we must check the message.
    if (e?.message?.includes(INVALID_YAML_ERROR_STRING)) {
      throw e;
    }
    return undefined;
  }
}

export function workflowSettingsAsProjectConfig(
  workflowSettings: sqlanvil.WorkflowSettings
): sqlanvil.ProjectConfig {
  const projectConfig = sqlanvil.ProjectConfig.create();
  if (workflowSettings.defaultProject) {
    projectConfig.defaultDatabase = workflowSettings.defaultProject;
  }
  if (workflowSettings.defaultDataset) {
    projectConfig.defaultSchema = workflowSettings.defaultDataset;
  }
  if (workflowSettings.defaultLocation) {
    projectConfig.defaultLocation = workflowSettings.defaultLocation;
  }
  if (workflowSettings.defaultAssertionDataset) {
    projectConfig.assertionSchema = workflowSettings.defaultAssertionDataset;
  }
  if (workflowSettings.vars) {
    projectConfig.vars = workflowSettings.vars;
  }
  if (workflowSettings.projectSuffix) {
    projectConfig.databaseSuffix = workflowSettings.projectSuffix;
  }
  if (workflowSettings.datasetSuffix) {
    projectConfig.schemaSuffix = workflowSettings.datasetSuffix;
  }
  if (workflowSettings.namePrefix) {
    projectConfig.tablePrefix = workflowSettings.namePrefix;
  }
  if (workflowSettings.builtinAssertionNamePrefix) {
    projectConfig.builtinAssertionNamePrefix = workflowSettings.builtinAssertionNamePrefix;
  }
  if (workflowSettings.defaultNotebookRuntimeOptions) {
    projectConfig.defaultNotebookRuntimeOptions = {};
    const {outputBucket, runtimeTemplateName, repositorySnapshotDestination} =
      workflowSettings.defaultNotebookRuntimeOptions;
    if (outputBucket) {
      projectConfig.defaultNotebookRuntimeOptions.outputBucket = outputBucket;
    }
    if (runtimeTemplateName) {
      projectConfig.defaultNotebookRuntimeOptions.runtimeTemplateName = runtimeTemplateName;
    }
    if (repositorySnapshotDestination) {
      projectConfig.defaultNotebookRuntimeOptions.repositorySnapshotDestination = {};
      if (repositorySnapshotDestination.repositorySnapshotUri) {
        projectConfig.defaultNotebookRuntimeOptions.repositorySnapshotDestination.repositorySnapshotUri =
          repositorySnapshotDestination.repositorySnapshotUri;
      } else if (outputBucket) {
        projectConfig.defaultNotebookRuntimeOptions.repositorySnapshotDestination.repositorySnapshotUri =
          outputBucket;
      } else {
        throw Error(
          "Invalid repository_snapshot_destination: either repository_snapshot_uri or output_bucket " +
            "has to be defined");
      }
    }
  }
  if(workflowSettings.defaultIcebergConfig) {
    projectConfig.defaultIcebergConfig = {};
    if(workflowSettings.defaultIcebergConfig.bucketName) {
      projectConfig.defaultIcebergConfig.bucketName = workflowSettings.defaultIcebergConfig.bucketName;
    }
    if(workflowSettings.defaultIcebergConfig.tableFolderRoot) {
      projectConfig.defaultIcebergConfig.tableFolderRoot = workflowSettings.defaultIcebergConfig.tableFolderRoot;
    }
    if(workflowSettings.defaultIcebergConfig.tableFolderSubpath) {
      projectConfig.defaultIcebergConfig.tableFolderSubpath = workflowSettings.defaultIcebergConfig.tableFolderSubpath;
    }
    if(workflowSettings.defaultIcebergConfig.connection) {
      projectConfig.defaultIcebergConfig.connection = workflowSettings.defaultIcebergConfig.connection;
    }
  }
  if(workflowSettings.disableAssertions) {
    projectConfig.disableAssertions = workflowSettings.disableAssertions;
  }
  if (workflowSettings.defaultReservation) {
    projectConfig.defaultReservation = workflowSettings.defaultReservation;
  }
  if (workflowSettings.includeTestsInCompiledGraph) {
    projectConfig.includeTestsInCompiledGraph = workflowSettings.includeTestsInCompiledGraph;
  }

  projectConfig.warehouse = "bigquery";
  return projectConfig;
}
