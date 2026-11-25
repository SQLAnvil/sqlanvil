import * as fs from "fs-extra";
import { load as loadYaml, YAMLException } from "js-yaml";
import * as path from "path";
import * as semver from "semver";
import * as util from "util";

import { sqlanvil } from "sa/protos/ts";

export function prettyJsonStringify(obj: object) {
  return JSON.stringify(obj, null, 4) + "\n";
}

function formatInvalidCoreVersion(coreVersion: unknown): string {
  if (typeof coreVersion === "string") {
    return JSON.stringify(coreVersion);
  }
  if (coreVersion === null || typeof coreVersion !== "object") {
    return String(coreVersion);
  }
  try {
    return JSON.stringify(coreVersion) ?? util.inspect(coreVersion, { breakLength: Infinity });
  } catch {
    return util.inspect(coreVersion, { breakLength: Infinity });
  }
}

/**
 * Throws unless `coreVersion` is an exact semantic version (upstream #2448). The pinned version is
 * written into a temporary package.json and handed to `npm i`, so anything else (a range, a tag,
 * a URL, or a string that closes the JSON string) must be rejected before the temporary directory
 * is created.
 */
export function validateSqlanvilCoreVersion(coreVersion: unknown): void {
  if (typeof coreVersion !== "string" || semver.valid(coreVersion) !== coreVersion) {
    throw new Error(
      `Invalid sqlanvilCoreVersion ${formatInvalidCoreVersion(coreVersion)}: must be a valid semantic version.`,
    );
  }
}

export function readSqlanvilCoreVersionFromWorkflowSettings(
  resolvedProjectPath: string,
): string | undefined {
  return readConfigFromWorkflowSettings(resolvedProjectPath)?.sqlanvilCoreVersion;
}

export function readConfigFromWorkflowSettings(
  resolvedProjectPath: string,
): sqlanvil.WorkflowSettings | undefined {
  const workflowSettingsPath = path.join(resolvedProjectPath, "workflow_settings.yaml");
  if (!fs.existsSync(workflowSettingsPath)) {
    return;
  }

  const workflowSettingsContent = fs.readFileSync(workflowSettingsPath, "utf-8");
  let workflowSettingsAsJson: unknown = {};
  try {
    workflowSettingsAsJson = loadYaml(workflowSettingsContent);
  } catch (e) {
    if (e instanceof YAMLException) {
      throw new Error(`${workflowSettingsPath} is not a valid YAML file: ${e}`);
    }
    throw e;
  }
  if (
    workflowSettingsAsJson !== null &&
    typeof workflowSettingsAsJson === "object" &&
    !Array.isArray(workflowSettingsAsJson)
  ) {
    const rawCoreVersion = (workflowSettingsAsJson as { sqlanvilCoreVersion?: unknown })
      .sqlanvilCoreVersion;
    if (rawCoreVersion !== undefined && rawCoreVersion !== null && rawCoreVersion !== "") {
      validateSqlanvilCoreVersion(rawCoreVersion);
    }
    return sqlanvil.WorkflowSettings.create(workflowSettingsAsJson as sqlanvil.IWorkflowSettings);
  }
  return sqlanvil.WorkflowSettings.create({});
}
