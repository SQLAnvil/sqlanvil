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

const VALID_FORMATS = ["parquet", "csv", "json"];

/**
 * Imports load a Parquet/CSV/JSON file into a table in the warehouse — the inverse of
 * `type: "export"`. The resulting table is `ref()`-able by downstream actions, so an import is a
 * *producer* (unlike export, a terminal sink). It is config-only: no SQL body — the source is the
 * file at `location`, the destination is the action's target.
 *
 * ```sql
 * -- definitions/orders_in.sqlx
 * config {
 *   type: "import",
 *   import: { location: "s3://bucket/orders/*.parquet", format: "parquet", overwrite: true }
 * }
 * -- Note: no SQL should be present.
 * ```
 *
 * On BigQuery this compiles to a native `LOAD DATA` statement (gs:// only). On Postgres/Supabase
 * the runner performs the load via DuckDB (read the file, write into the warehouse). Data is loaded
 * as-is (no transform) — shape it in a downstream model.
 */
export class Import extends ActionBuilder<sqlanvil.Import> {
  /** @hidden */
  public session: Session;

  /** @hidden */
  public dependOnDependencyAssertions: boolean = false;

  /** @hidden */
  private proto = sqlanvil.Import.create();

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

    // The import: {} block (source + format).
    const imp = config.import || sqlanvil.ActionConfig.ImportOptions.create();
    this.proto.location = imp.location || "";
    this.proto.format = (imp.format || "").toLowerCase();
    // overwrite defaults to true unless the config explicitly sets it.
    this.proto.overwrite =
      unverifiedConfig.import && unverifiedConfig.import.hasOwnProperty("overwrite")
        ? !!imp.overwrite
        : true;
    if (imp.options) {
      this.proto.options = imp.options;
    }
    return this;
  }

  /** @hidden Adds dependencies (used by `${ref()}` resolution and explicit dependency_targets). */
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
    this.validate();

    return verifyObjectMatchesProto(
      sqlanvil.Import,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }

  /** @hidden Source/format/warehouse validation. */
  private validate() {
    const fileName = this.proto.fileName;
    if (!this.proto.location) {
      this.session.compileError(
        new Error("Import actions require a `location` in the import config."),
        fileName
      );
      return;
    }
    if (!VALID_FORMATS.includes(this.proto.format)) {
      this.session.compileError(
        new Error(
          `Invalid import format "${this.proto.format}". Valid formats: ${VALID_FORMATS.join(
            ", "
          )}.`
        ),
        fileName
      );
    }
    const warehouse = (this.session.projectConfig.warehouse || "bigquery").toLowerCase();
    if (warehouse === "bigquery" && !this.proto.location.startsWith("gs://")) {
      const scheme = this.proto.location.includes("://")
        ? `${this.proto.location.split("://")[0]}://`
        : "a local path";
      this.session.compileError(
        new Error(`BigQuery imports support only gs:// sources; got ${scheme}.`),
        fileName
      );
    }
  }

  private verifyConfig(unverifiedConfig: any): sqlanvil.ActionConfig.ImportConfig {
    if (unverifiedConfig.type) {
      delete unverifiedConfig.type;
    }
    return verifyObjectMatchesProto(
      sqlanvil.ActionConfig.ImportConfig,
      unverifiedConfig,
      VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
  }
}
