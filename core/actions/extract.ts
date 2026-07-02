import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IExtractConfig {
  /** Destination table name. */
  name: string;
  /** Destination schema (the `<conn>_ext` schema, mirroring the FDW bridge). */
  schema?: string;
  /** The named source connection (keys into .df-credentials.json `connections` for auth). */
  connectionName: string;
  /** Source platform — "bigquery" for now. */
  platform: string;
  /** Source project (BigQuery reads `project.dataset.sourceName`). */
  project?: string;
  /** Source dataset. */
  dataset?: string;
  /** Source object name (defaults to `name`). */
  sourceName?: string;
  /** BigQuery billing project (defaults to `project`). */
  billingProject?: string;
  /** Column name -> SQL type for the materialized table (from `sqlanvil introspect`). */
  columnTypes?: { [key: string]: string };
  filename?: string;
}

/**
 * A runner-extract source. The ref-able stand-in for a `connection:` declaration whose connection has
 * `mode: "runner-extract"`: instead of a live FDW foreign table, the CLI reads the cross-warehouse
 * source (keyless BigQuery) at run time and materializes the rows into this plain warehouse table. No
 * Vault secret, no `wrappers`/`postgis` — so it works on bare ephemeral branches. Synthesized by
 * `Session.declare()` (users write a `connection:` declaration, not `type: "extract"`).
 */
export class Extract extends ActionBuilder<sqlanvil.Extract> {
  public session: Session;

  private proto = sqlanvil.Extract.create();
  private config: IExtractConfig;

  constructor(session: Session, config: IExtractConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name, schema: config.schema });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
      validateTarget: true
    });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";
    this.proto.connectionName = config.connectionName;
    this.proto.platform = config.platform;
    this.proto.project = config.project || "";
    this.proto.dataset = config.dataset || "";
    this.proto.sourceName = config.sourceName || config.name;
    this.proto.billingProject = config.billingProject || "";
    this.proto.columnTypes = config.columnTypes || {};
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    return verifyObjectMatchesProto(
      sqlanvil.Extract,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
