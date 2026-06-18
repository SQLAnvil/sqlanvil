import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions";
import { Contextable, IActionContext, Resolvable } from "sa/core/contextables";
import * as Path from "sa/core/path";
import { Session } from "sa/core/session";
import {
  actionConfigToCompiledGraphTarget,
  checkAssertionsForDependency,
  configTargetToCompiledGraphTarget,
  resolvableAsTarget,
  toResolvable
} from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

const VALID_FORMATS = ["parquet", "csv", "json"];

/**
 * Exports write the result of a SELECT to a Parquet/CSV/JSON file at a cloud or local location.
 *
 * ```sql
 * -- definitions/dump.sqlx
 * config {
 *   type: "export",
 *   export: { location: "s3://bucket/orders/", format: "parquet", overwrite: true }
 * }
 * SELECT * FROM ${ref("orders")}
 * ```
 *
 * On BigQuery this compiles to a native `EXPORT DATA` statement (gs:// only). On
 * Postgres/Supabase the runner performs the export via DuckDB.
 */
export class Export extends ActionBuilder<sqlanvil.Export> {
  /** @hidden */
  public session: Session;

  /** @hidden */
  public dependOnDependencyAssertions: boolean = false;

  /** @hidden */
  private proto = sqlanvil.Export.create();

  /** @hidden We delay contextification until the final compile step. */
  private contextableQuery: Contextable<IActionContext, string>;

  /** @hidden */
  constructor(session?: Session, unverifiedConfig?: any, configPath?: string) {
    super(session);
    this.session = session;

    if (!unverifiedConfig) {
      return;
    }

    const config = this.verifyConfig(unverifiedConfig);

    if (!config.name) {
      config.name = Path.basename(config.filename);
    }
    const target = actionConfigToCompiledGraphTarget(config);
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
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
    if (config.hermetic !== undefined) {
      this.hermetic(config.hermetic);
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
    if (config.project) {
      this.database(config.project);
    }
    if (config.dataset) {
      this.schema(config.dataset);
    }
    if (config.filename) {
      this.proto.fileName = config.filename;
    }

    // The export: {} block (destination + format).
    const exp = config.export || sqlanvil.ActionConfig.ExportOptions.create();
    this.proto.location = exp.location || "";
    this.proto.format = (exp.format || "").toLowerCase();
    // overwrite defaults to true unless the config explicitly sets it.
    this.proto.overwrite =
      unverifiedConfig.export && unverifiedConfig.export.hasOwnProperty("overwrite")
        ? !!exp.overwrite
        : true;
    this.proto.filename = exp.filename || this.proto.target.name;
    if (exp.options) {
      this.proto.options = exp.options;
    }
    return this;
  }

  /** Sets the SELECT whose result is exported. */
  public query(contextable: Contextable<IActionContext, string>) {
    this.contextableQuery = contextable;
    return this;
  }

  /** @hidden Adds dependencies (used by `${ref()}` resolution). */
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
  public hermetic(hermetic: boolean) {
    this.proto.hermeticity = hermetic
      ? sqlanvil.ActionHermeticity.HERMETIC
      : sqlanvil.ActionHermeticity.NON_HERMETIC;
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
  public database(database: string) {
    this.proto.target = this.applySessionToTarget(
      sqlanvil.Target.create({ ...this.proto.target, database }),
      this.session.projectConfig,
      this.proto.fileName,
      { validateTarget: true }
    );
    return this;
  }

  /** @hidden */
  public schema(schema: string) {
    this.proto.target = this.applySessionToTarget(
      sqlanvil.Target.create({ ...this.proto.target, schema }),
      this.session.projectConfig,
      this.proto.fileName,
      { validateTarget: true }
    );
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
    const context = new ExportContext(this);
    this.proto.query = context.apply(this.contextableQuery);

    this.validate();

    return verifyObjectMatchesProto(
      sqlanvil.Export,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }

  /** @hidden Scheme/format/warehouse validation. Filled in by the validation task. */
  private validate() {
    // Intentionally minimal here; validation rules are added in a dedicated task.
  }

  private verifyConfig(unverifiedConfig: any): sqlanvil.ActionConfig.ExportConfig {
    if (unverifiedConfig.type) {
      delete unverifiedConfig.type;
    }
    return verifyObjectMatchesProto(
      sqlanvil.ActionConfig.ExportConfig,
      unverifiedConfig,
      VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
  }
}

/**
 * @hidden
 */
export class ExportContext implements IActionContext {
  private exportAction: Export;

  constructor(exportAction: Export) {
    this.exportAction = exportAction;
  }

  public self(): string {
    return this.resolve(this.exportAction.getTarget());
  }

  public name(): string {
    return this.exportAction.session.finalizeName(this.exportAction.getTarget().name);
  }

  public ref(ref: Resolvable | string[], ...rest: string[]) {
    ref = toResolvable(ref, rest);
    if (!resolvableAsTarget(ref)) {
      this.exportAction.session.compileError(new Error(`Action name is not specified`));
      return "";
    }
    this.exportAction.dependencies(ref);
    return this.resolve(ref);
  }

  public resolve(ref: Resolvable | string[], ...rest: string[]) {
    return this.exportAction.session.resolve(ref, ...rest);
  }

  public schema(): string {
    return this.exportAction.session.finalizeSchema(this.exportAction.getTarget().schema);
  }

  public database(): string {
    if (!this.exportAction.getTarget().database) {
      this.exportAction.session.compileError(
        new Error(`Warehouse does not support multiple databases`)
      );
      return "";
    }
    return this.exportAction.session.finalizeDatabase(this.exportAction.getTarget().database);
  }

  public dependencies(name: Resolvable | Resolvable[]) {
    this.exportAction.dependencies(name);
    return "";
  }

  public tags(name: string | string[]) {
    this.exportAction.tags(name);
    return "";
  }

  public hasOutput(hasOutput: boolean) {
    return "";
  }

  public when(cond: boolean, trueCase: string, falseCase: string = "") {
    return cond ? trueCase : falseCase;
  }

  public apply<T>(value: Contextable<IActionContext, T>): T {
    if (typeof value === "function") {
      return (value as any)(this);
    } else {
      return value;
    }
  }
}
