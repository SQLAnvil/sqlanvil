import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions";
import { ColumnDescriptors } from "sa/core/column_descriptors";
import { Session } from "sa/core/session";
import { actionConfigToCompiledGraphTarget } from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

/**
 * @hidden
 * @deprecated
 * This maintains backwards compatability with older versions.
 * Consider breaking backwards compatability of these in v4.
 */
interface ILegacyDeclarationConfig extends sqlanvil.ActionConfig.DeclarationConfig {
  database: string;
  schema: string;
  fileName: string;
  type: string;
}

/**
 * You can declare any BigQuery table as a data source in sqlanvil. Declaring BigQuery data
 * sources that are external to sqlanvil lets you treat those data sources as sqlanvil objects.
 *
 * Declaring data sources is optional, but can be useful when you want to do the following:
 * * Reference or resolve declared sources in the same way as any other table in sqlanvil.
 * * View declared sources in the visualized sqlanvil graph.
 * * Use sqlanvil to manage the table-level and column-level descriptions of externally created
 *   tables.
 * * Trigger workflow invocations that include all the dependents of an external data source.
 *
 * You can create declarations in the following ways. Available config options are defined in
 * [DeclarationConfig](configs#sqlanvil-ActionConfig-DeclarationConfig), and are shared across all
 * the followiing ways of creating declarations.
 *
 * **Using a SQLX file:**
 *
 * ```sql
 * -- definitions/name.sqlx
 * config {
 *   type: "declaration"
 * }
 * -- Note: no SQL should be present.
 * ```
 *
 * **Using action configs files:**
 *
 * ```yaml
 * # definitions/actions.yaml
 * actions:
 * - declare:
 *   name: name
 * ```
 *
 * **Using the Javascript API:**
 *
 * ```js
 * // definitions/file.js
 * declare("name")
 * ```
 */
export class Declaration extends ActionBuilder<sqlanvil.Declaration> {
  /** @hidden Hold a reference to the Session instance. */
  public session: Session;

  /**
   * @hidden Stores the generated proto for the compiled graph.
   */
  private proto = sqlanvil.Declaration.create();

  /** @hidden */
  constructor(session?: Session, unverifiedConfig?: any, filename?: string) {
    super(session);
    this.session = session;

    if (!unverifiedConfig) {
      return;
    }

    const config = this.verifyConfig(unverifiedConfig);

    if (!config.name) {
      throw Error("Declarations must have a populated 'name' field.");
    }

    const target = actionConfigToCompiledGraphTarget(config);
    this.proto.target = this.applySessionToTarget(
      target,
      session.projectConfig,
      config.filename || filename
    );
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);

    if (config.description) {
      this.description(config.description);
    }
    if (config.columns?.length) {
      this.columns(
        config.columns.map(columnDescriptor =>
          sqlanvil.ActionConfig.ColumnDescriptor.create(columnDescriptor)
        )
      );
    }
    this.proto.fileName = config.filename || filename;
    this.proto.tags = config.tags || [];
    return this;
  }

  /**
   * @deprecated Deprecated in favor of
   * [DeclarationConfig.description](configs#sqlanvil-ActionConfig-DeclarationConfig).
   *
   * Sets the description of this assertion.
   */
  public description(description: string) {
    if (!this.proto.actionDescriptor) {
      this.proto.actionDescriptor = {};
    }
    this.proto.actionDescriptor.description = description;
    return this;
  }

  /**
   * @deprecated Deprecated in favor of
   * [DeclarationConfig.columns](configs#sqlanvil-ActionConfig-DeclarationConfig).
   *
   * Sets the column descriptors of columns in this table.
   */
  public columns(columns: sqlanvil.ActionConfig.ColumnDescriptor[]) {
    if (!this.proto.actionDescriptor) {
      this.proto.actionDescriptor = {};
    }
    this.proto.actionDescriptor.columns = ColumnDescriptors.mapConfigProtoToCompilationProto(
      columns
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
    return verifyObjectMatchesProto(
      sqlanvil.Declaration,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }

  /**
   * @hidden Verify config checks that the constructor provided config matches the expected proto
   * structure, or the previously accepted legacy structure. If the legacy structure is used, it is
   * converted to the new structure.
   */
  private verifyConfig(
    unverifiedConfig: ILegacyDeclarationConfig
  ): sqlanvil.ActionConfig.DeclarationConfig {
    if (unverifiedConfig.database) {
      unverifiedConfig.project = unverifiedConfig.database;
      delete unverifiedConfig.database;
    }
    if (unverifiedConfig.schema) {
      unverifiedConfig.dataset = unverifiedConfig.schema;
      delete unverifiedConfig.schema;
    }
    if (unverifiedConfig.columns) {
      unverifiedConfig.columns = ColumnDescriptors.mapLegacyObjectToConfigProto(
        unverifiedConfig.columns as any
      );
    }

    if (unverifiedConfig.type) {
      delete unverifiedConfig.type;
    }

    return verifyObjectMatchesProto(
      sqlanvil.ActionConfig.DeclarationConfig,
      unverifiedConfig,
      VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
  }
}
