import * as fs from "fs-extra";
import { load as loadYaml, YAMLException } from "js-yaml";
import * as path from "path";

import { sqlanvil } from "sa/protos/ts";

export function prettyJsonStringify(obj: object) {
  return JSON.stringify(obj, null, 4) + "\n";
}

export function readDataformCoreVersionFromWorkflowSettings(
  resolvedProjectPath: string
): string | undefined {
  return readConfigFromWorkflowSettings(resolvedProjectPath)?.sqlanvilCoreVersion;
}

export function readConfigFromWorkflowSettings(
  resolvedProjectPath: string
): sqlanvil.WorkflowSettings | undefined {
  const workflowSettingsPath = path.join(resolvedProjectPath, "workflow_settings.yaml");
  if (!fs.existsSync(workflowSettingsPath)) {
    return;
  }

  const workflowSettingsContent = fs.readFileSync(workflowSettingsPath, "utf-8");
  let workflowSettingsAsJson = {};
  try {
    workflowSettingsAsJson = loadYaml(workflowSettingsContent);
  } catch (e) {
    if (e instanceof YAMLException) {
      throw new Error(`${workflowSettingsPath} is not a valid YAML file: ${e}`);
    }
    throw e;
  }
  return sqlanvil.WorkflowSettings.create(workflowSettingsAsJson);
}
