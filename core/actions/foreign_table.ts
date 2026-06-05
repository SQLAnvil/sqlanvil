import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IForeignTableConfig {
  name: string;
  schema?: string;
  server: string;
  options?: { [key: string]: string };
  columns?: { [key: string]: string };
  // Target name of the wrapper server-setup action this table depends on.
  dependsOn: string;
  filename?: string;
}

export class ForeignTable extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IForeignTableConfig;

  constructor(session: Session, config: IForeignTableConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name, schema: config.schema });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
      validateTarget: true
    });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";
    this.proto.hasOutput = true;
    this.proto.dependencyTargets = [sqlanvil.Target.create({ name: config.dependsOn })];
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    const qualified = this.config.schema
      ? `"${this.config.schema}"."${this.config.name}"`
      : `"${this.config.name}"`;

    const cols = Object.entries(this.config.columns || {}).map(([c, t]) => `"${c}" ${t}`);
    const colsStr = cols.length > 0 ? ` (${cols.join(", ")})` : "";

    const optionsArray = Object.entries(this.config.options || {}).map(
      ([k, v]) => `${k} '${String(v).replace(/'/g, "''")}'`
    );
    const optionsStr = optionsArray.length > 0 ? ` options (${optionsArray.join(", ")})` : "";

    this.proto.queries = [
      `drop foreign table if exists ${qualified}`,
      `create foreign table ${qualified}${colsStr} server "${this.config.server}"${optionsStr}`
    ];

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
