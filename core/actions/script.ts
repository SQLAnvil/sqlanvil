import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions";
import { Resolvable } from "sa/core/contextables";
import * as Path from "sa/core/path";
import { Session } from "sa/core/session";
import {
  actionConfigToCompiledGraphTarget,
  checkAssertionsForDependency,
  configTargetToCompiledGraphTarget
} from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

/** Languages with a run-time resolver in the CLI. */
const SUPPORTED_LANGUAGES = ["python"];

/**
 * One clause of a version specifier: an operator followed by a version, e.g. ">=3.11" or
 * "==3.12.*". Covers the PEP 440 operator set; the version part is validated loosely (the CLI's
 * per-language resolver does the real comparison at validate/run time — compile only rejects
 * clearly malformed specifiers, deterministically).
 */
const SPECIFIER_CLAUSE = /^(===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9][A-Za-z0-9.*+!_-]*$/;

/** @hidden Well-formedness check for a comma-separated version specifier (PEP 440 shaped). */
export function isWellFormedVersionSpecifier(specifier: string): boolean {
  return specifier
    .split(",")
    .map(clause => clause.trim())
    .every(clause => SPECIFIER_CLAUSE.test(clause));
}

/**
 * Script actions run user code (Python in v1) at execution time: file-staging and glue steps as
 * first-class DAG nodes, ordered by `dependencies` and covered by run history. Declared in
 * `actions.yaml` — the friendly form is a `python:` entry (sugar for
 * `script: { language: "python", ... }`):
 *
 * ```yaml
 * actions:
 *   - python:
 *       name: load_openaddresses
 *       file: loader/load_openaddresses.py
 *       args: ["northeast"]
 *       requirements: loader/requirements.txt
 *       pythonVersion: ">=3.11"
 *       venv: .venv
 *       tags: ["ingest"]
 * ```
 *
 * The script is spawned with cwd = the project directory and env `SA_VARS` (a JSON object of
 * `vars`) + `SA_ACTION_NAME`; exit code 0 is success. **No warehouse credentials are injected** —
 * scripts produce files, and `type: "import"` is the loading boundary. sqlanvil validates the
 * declared environment (`sqlanvil validate` checks the interpreter version, the requirements
 * manifest against the installed packages, and the script's syntax) but never installs anything —
 * the environment is yours.
 */
export class Script extends ActionBuilder<sqlanvil.Script> {
  /** @hidden */
  public session: Session;

  /** @hidden */
  public dependOnDependencyAssertions: boolean = false;

  /** @hidden */
  private proto = sqlanvil.Script.create();

  /** @hidden */
  constructor(
    session?: Session,
    unverifiedConfig?: any,
    configPath?: string,
    projectFiles?: string[]
  ) {
    super(session);
    this.session = session;

    if (!unverifiedConfig) {
      return;
    }

    const config = this.verifyConfig(unverifiedConfig);

    if (!config.name) {
      config.name = Path.basename(config.filename || "");
    }
    const target = actionConfigToCompiledGraphTarget(config);
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, configPath, {
      validateTarget: true
    });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);

    if (config.dependencyTargets) {
      this.dependencies(
        config.dependencyTargets.map(dependencyTarget =>
          configTargetToCompiledGraphTarget(sqlanvil.ActionConfig.Target.create(dependencyTarget))
        )
      );
    }
    if (config.disabled) {
      this.disabled();
    }
    if (config.tags) {
      this.tags(config.tags);
    }
    if (config.description) {
      this.description(config.description);
    }

    // Scripts read/write arbitrary files, so they are never hermetic.
    this.proto.hermeticity = sqlanvil.ActionHermeticity.NON_HERMETIC;
    this.proto.fileName = configPath || "";
    this.proto.language = (config.language || "").toLowerCase();
    this.proto.scriptFilename = config.filename || "";
    this.proto.args = config.args || [];
    this.proto.depsFile = config.depsFile || "";
    this.proto.runtimeVersion = config.runtimeVersion || "";
    this.proto.envRoot = config.envRoot || "";
    this.proto.timeoutMillis = config.timeoutMillis || 0;

    this.checkConfig(projectFiles);
    return this;
  }

  /** @hidden Adds dependencies (explicit dependency_targets). */
  public dependencies(value: Resolvable | Resolvable[]) {
    const newDependencies = Array.isArray(value) ? value : [value];
    newDependencies.forEach(resolvable => {
      const dependencyTarget = checkAssertionsForDependency(this, resolvable);
      if (!!dependencyTarget) {
        this.proto.dependencyTargets.push(dependencyTarget);
      }
    });
    return this;
  }

  /** @hidden */
  public disabled(disabled = true) {
    this.proto.disabled = disabled;
    return this;
  }

  /** @hidden */
  public tags(value: string | string[]) {
    const newTags = typeof value === "string" ? [value] : value;
    newTags.forEach(t => {
      if (this.proto.tags.indexOf(t) < 0) {
        this.proto.tags.push(t);
      }
    });
    return this;
  }

  /** @hidden */
  public description(description: string) {
    if (!this.proto.actionDescriptor) {
      this.proto.actionDescriptor = {};
    }
    this.proto.actionDescriptor.description = description;
    return this;
  }

  /** @hidden */
  public getFileName() {
    return this.proto.fileName;
  }

  /** @hidden */
  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  /** @hidden */
  public compile() {
    return verifyObjectMatchesProto(
      sqlanvil.Script,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }

  /**
   * @hidden Deterministic compile-time checks: config shape and file existence within the
   * project tree (`projectFiles` is the compiler's own file index — machine state is never a
   * compile input). Environment reality (interpreter, installed packages, script syntax) is
   * checked by `sqlanvil validate`, which is allowed to touch the machine.
   */
  private checkConfig(projectFiles?: string[]) {
    const fileName = this.proto.fileName;
    if (!this.proto.language) {
      this.session.compileError(
        new Error("Script actions require a `language` (use the `python:` actions.yaml key)."),
        fileName
      );
    } else if (!SUPPORTED_LANGUAGES.includes(this.proto.language)) {
      this.session.compileError(
        new Error(
          `Unsupported script language "${this.proto.language}". Supported: ` +
            `${SUPPORTED_LANGUAGES.join(", ")}.`
        ),
        fileName
      );
    }
    if (!this.proto.scriptFilename) {
      this.session.compileError(
        new Error("Script actions require a `file` (the script path, relative to the project root)."),
        fileName
      );
    }
    // The compiler's file index skips dotfile paths (e.g. inside .venv/), so only nested,
    // non-dot paths can be existence-checked deterministically here.
    const checkable = (path: string) =>
      !!projectFiles && path.includes("/") && !path.split("/").some(part => part.startsWith("."));
    if (this.proto.scriptFilename && checkable(this.proto.scriptFilename)) {
      if (!projectFiles.includes(this.proto.scriptFilename)) {
        this.session.compileError(
          new Error(`Script file not found in the project: "${this.proto.scriptFilename}".`),
          fileName
        );
      }
    }
    if (this.proto.depsFile && checkable(this.proto.depsFile)) {
      if (!projectFiles.includes(this.proto.depsFile)) {
        this.session.compileError(
          new Error(`Script requirements file not found in the project: "${this.proto.depsFile}".`),
          fileName
        );
      }
    }
    if (this.proto.runtimeVersion && !isWellFormedVersionSpecifier(this.proto.runtimeVersion)) {
      this.session.compileError(
        new Error(
          `Malformed runtime version specifier "${this.proto.runtimeVersion}". Expected ` +
            `comma-separated clauses like ">=3.11" or ">=3.11,<3.14".`
        ),
        fileName
      );
    }
    if (this.proto.timeoutMillis < 0) {
      this.session.compileError(
        new Error("Script `timeoutMillis` must be a non-negative number of milliseconds."),
        fileName
      );
    }
  }

  private verifyConfig(unverifiedConfig: any): sqlanvil.ActionConfig.ScriptConfig {
    if (unverifiedConfig.type) {
      delete unverifiedConfig.type;
    }
    return verifyObjectMatchesProto(
      sqlanvil.ActionConfig.ScriptConfig,
      unverifiedConfig,
      VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
  }
}
