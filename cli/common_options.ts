import * as fs from "fs";
import parseDuration from "parse-duration";
import * as path from "path";
import yargs from "yargs";

import { CREDENTIALS_FILENAME } from "sa/cli/api/commands/credentials";
import {
  mergeProjectConfigOverride,
  resolveCredentials,
  resolveEnvironment
} from "sa/cli/api/commands/environments";
import { ProjectConfigArgv, ProjectConfigOptions } from "sa/cli/project_config_options";
import { actuallyResolve, assertPathExists } from "sa/cli/util";
import { INamedOption, option, positionalOption } from "sa/cli/yargswrapper";
import { sqlanvil } from "sa/protos/ts";

// Options shared by two or more commands, plus the environment-aware helpers that
// compile/run/test/validate all go through. Command-specific options live next to
// their command under cli/commands/.
//
// Per-command argv interfaces: yargs gained a well-typed API in v12; rather than
// rewrite the data-driven command builder onto the fluent chain, each command's
// handler is annotated with the interface describing exactly the args it reads.
// The `option`/`positionalOption` factories (yargswrapper) capture each flag name
// as a string literal, so `argv[someOption.name]` indexes these interfaces by the
// exact key. Types reflect post-`coerce` values (e.g. timeout: number, project-dir:
// string). Optional members marked `?` are either non-defaulted flags or — noted
// inline — flags a handler reads without declaring (undefined at runtime today).

/** The selection flags (`--actions`/`--tags` plus the include-* modifiers). */
interface SelectionArgv {
  actions?: string[];
  tags?: string[];
  "include-deps"?: boolean;
  "include-dependents"?: boolean;
}

export const projectDirOption: INamedOption<
  yargs.PositionalOptions,
  "project-dir"
> = positionalOption("project-dir", {
  describe: "The sqlanvil project directory.",
  default: ".",
  coerce: actuallyResolve
});

export const projectDirMustExistOption: INamedOption<yargs.PositionalOptions, "project-dir"> = {
  ...projectDirOption,
  check: (argv: { "project-dir": string; graph?: string }) => {
    assertPathExists(argv[projectDirOption.name]);
    // With --graph the compiled graph IS the project — the directory is only a working dir
    // (credentials, artifacts), so don't require workflow_settings.yaml there.
    if (argv.graph) {
      return;
    }
    const workflowSettingsYamlPath = path.resolve(
      argv[projectDirOption.name],
      "workflow_settings.yaml"
    );
    if (!fs.existsSync(workflowSettingsYamlPath)) {
      throw new Error(
        `${
          argv[projectDirOption.name]
        } does not appear to be a sqlanvil directory (missing workflow_settings.yaml file).`
      );
    }
  }
};

export const actionsOption: INamedOption<yargs.Options, "actions"> = option("actions", {
  describe: "A list of action names or patterns to run. Can include '*' wildcards.",
  type: "array",
  coerce: (rawActions: string[] | null) => rawActions.map(actions => actions.split(",")).flat()
});

export const tagsOption: INamedOption<yargs.Options, "tags"> = option("tags", {
  describe: "A list of tags to filter the actions to run.",
  type: "array",
  coerce: (rawTags: string[] | null) => rawTags.map(tags => tags.split(",")).flat()
});

export const includeDepsOption: INamedOption<yargs.Options, "include-deps"> = option(
  "include-deps",
  {
    describe: "If set, dependencies for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  (argv: Pick<SelectionArgv, "include-deps" | "actions" | "tags">) => {
    if (argv[includeDepsOption.name] && !(argv[actionsOption.name] || argv[tagsOption.name])) {
      throw new Error(
        `The --${includeDepsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
);

export const includeDependentsOption: INamedOption<yargs.Options, "include-dependents"> = option(
  "include-dependents",
  {
    describe: "If set, dependents (downstream) for selected actions will also be run.",
    type: "boolean"
  },
  // It would be nice to use yargs' "implies" to implement this, but it doesn't work for some reason.
  (argv: Pick<SelectionArgv, "include-dependents" | "actions" | "tags">) => {
    if (
      argv[includeDependentsOption.name] &&
      !(argv[actionsOption.name] || argv[tagsOption.name])
    ) {
      throw new Error(
        `The --${includeDependentsOption.name} flag should only be supplied along with --${actionsOption.name} or --${tagsOption.name}.`
      );
    }
  }
);

export const credentialsOption: INamedOption<yargs.Options, "credentials"> = option(
  "credentials",
  {
    describe: "The location of the credentials JSON file to use.",
    default: CREDENTIALS_FILENAME
  },
  (argv: { "project-dir": string; credentials: string }) => {
    getCredentialsPath(argv[projectDirOption.name], argv.credentials);
  }
);

export const jsonOutputOption: INamedOption<yargs.Options, "json"> = option("json", {
  describe: "Outputs a JSON representation of the compiled project or test results.",
  type: "boolean",
  default: false
});

export const timeoutOption: INamedOption<yargs.Options, "timeout"> = option("timeout", {
  describe: "Duration to allow project compilation to complete. Examples: '1s', '10m', etc.",
  type: "string",
  default: null,
  coerce: (rawTimeoutString: string | null) =>
    rawTimeoutString ? parseDuration(rawTimeoutString) : null
});

// Declared as the positive `artifacts` so yargs' own boolean negation produces the documented
// `--no-artifacts`. Declaring "no-artifacts" instead made yargs read the flag as a negation of an
// undeclared `artifacts` and reject it in strict mode ("Unknown argument: artifacts").
export const artifactsOption: INamedOption<yargs.Options, "artifacts"> = option("artifacts", {
  describe:
    "Write the queryable Parquet artifacts under target/ (catalog on compile; run history on " +
    "run). Pass --no-artifacts to skip them.",
  type: "boolean",
  default: true
});

export const quietCompileOption: INamedOption<yargs.Options, "quiet"> = option("quiet", {
  describe: "Less verbose compilation output. Example usage: 'sqlanvil compile --quiet'",
  type: "boolean",
  default: false
});

export function getCredentialsPath(projectDir: string, credentialsPath: string) {
  return actuallyResolve(projectDir, credentialsPath);
}

// projectConfigOverride that layers the named environment (if any) under the CLI
// flags. Used by compile/run/test.
export function projectConfigOverrideWithEnvironment(
  projectDir: string,
  argv: ProjectConfigArgv
): sqlanvil.IProjectConfig {
  const cliOverride = ProjectConfigOptions.constructProjectConfigOverride(argv);
  if (!argv[ProjectConfigOptions.environment.name]) {
    return cliOverride;
  }
  const { configOverride } = resolveEnvironment(
    projectDir,
    argv[ProjectConfigOptions.environment.name]
  );
  return mergeProjectConfigOverride(configOverride, cliOverride);
}

// Resolved absolute credentials path, applying --credentials > env > default. Used
// by run/test.
export function credentialsPathWithEnvironment(projectDir: string, argv: any): string {
  const envCredentials = argv[ProjectConfigOptions.environment.name]
    ? resolveEnvironment(projectDir, argv[ProjectConfigOptions.environment.name]).credentials
    : undefined;
  const chosen = resolveCredentials(
    envCredentials,
    argv[credentialsOption.name],
    CREDENTIALS_FILENAME
  );
  return getCredentialsPath(projectDir, chosen);
}
