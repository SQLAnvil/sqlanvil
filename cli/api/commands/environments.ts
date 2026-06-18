import { readConfigFromWorkflowSettings } from "sa/cli/api/utils";
import { sqlanvil } from "sa/protos/ts";

// Resolve a named environment from workflow_settings.yaml into a projectConfig
// override + an (optional) credentials-file path. Pure: reads config, maps fields,
// throws on an unknown/absent environment. CLI/path concerns stay in the caller.
export function resolveEnvironment(
  projectDir: string,
  envName: string
): { configOverride: sqlanvil.IProjectConfig; credentials?: string } {
  const settings = readConfigFromWorkflowSettings(projectDir);
  const environments = settings?.environments || {};
  const env = environments[envName];
  if (!env) {
    const available = Object.keys(environments);
    throw new Error(
      `Environment "${envName}" not found. ` +
        (available.length
          ? `Available environments: ${available.join(", ")}.`
          : `No environments defined in workflow_settings.yaml.`)
    );
  }
  const configOverride: sqlanvil.IProjectConfig = {};
  if (env.schemaSuffix) {
    configOverride.schemaSuffix = env.schemaSuffix;
  }
  if (env.vars && Object.keys(env.vars).length > 0) {
    configOverride.vars = env.vars;
  }
  if (env.defaultDatabase) {
    configOverride.defaultDatabase = env.defaultDatabase;
  }
  if (env.defaultLocation) {
    configOverride.defaultLocation = env.defaultLocation;
  }
  return { configOverride, credentials: env.credentials || undefined };
}

// Merge an environment's override under the CLI-flag override: CLI wins field-wise,
// and `vars` merge per-key (CLI key beats env key). Core later merges the result
// over workflow_settings vars, giving CLI > env > workflow_settings precedence.
export function mergeProjectConfigOverride(
  envOverride: sqlanvil.IProjectConfig,
  cliOverride: sqlanvil.IProjectConfig
): sqlanvil.IProjectConfig {
  const merged: sqlanvil.IProjectConfig = { ...envOverride, ...cliOverride };
  if (envOverride.vars || cliOverride.vars) {
    merged.vars = { ...envOverride.vars, ...cliOverride.vars };
  }
  return merged;
}

// Credentials precedence: an explicit --credentials (≠ the default filename) wins;
// else the environment's credentials; else the default. (yargs always supplies the
// default for --credentials, so "explicit" = value differs from the default.)
export function resolveCredentials(
  envCredentials: string | undefined,
  cliCredentials: string | undefined,
  defaultFilename: string
): string {
  if (cliCredentials && cliCredentials !== defaultFilename) {
    return cliCredentials;
  }
  return envCredentials || defaultFilename;
}
