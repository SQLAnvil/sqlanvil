import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IRealtimePublicationConfig {
  table: string;
  name?: string; // defaults to "supabase_realtime"
  events?: string[];
  filename?: string;
}

export class RealtimePublication extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IRealtimePublicationConfig;

  constructor(session: Session, config: IRealtimePublicationConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const tableTarget = this.applySessionToTarget(sqlanvil.Target.create({ name: config.table }), session.projectConfig);
    const pubName = config.name || "supabase_realtime";
    const target = sqlanvil.Target.create({ name: `${config.table}_realtime_${pubName}` });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, { validateTarget: true });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";

    // Automatically establish a compiler dependency on the parent table!
    this.proto.dependencyTargets.push(tableTarget);
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    const tableTarget = this.finalizeTarget(sqlanvil.Target.create({ name: this.config.table }));
    const resolvedTable = this.session.compilationSql().resolveTarget(tableTarget);
    const pubName = this.config.name || "supabase_realtime";

    // Generate realtime publication queries
    const queries = [
      `alter table ${resolvedTable} replica identity full`,
      `alter publication ${pubName} add table ${resolvedTable}`
    ];

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
