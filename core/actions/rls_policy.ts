import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IRlsPolicyConfig {
  table: string;
  name: string;
  command?: string; // "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE"
  roles?: string[];
  using?: string;
  withCheck?: string;
  filename?: string;
}

export class RlsPolicy extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IRlsPolicyConfig;

  constructor(session: Session, config: IRlsPolicyConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const tableTarget = this.applySessionToTarget(sqlanvil.Target.create({ name: config.table }), session.projectConfig);
    const target = sqlanvil.Target.create({ name: `${config.table}_policy_${config.name}` });
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
    const policyName = `"${this.config.name}"`;

    const command = this.config.command ? this.config.command.toUpperCase() : "ALL";
    const roles = this.config.roles && this.config.roles.length > 0
      ? this.config.roles.join(", ")
      : "PUBLIC";

    const usingClause = this.config.using ? ` USING (${this.config.using})` : "";
    const withCheckClause = this.config.withCheck ? ` WITH CHECK (${this.config.withCheck})` : "";

    // Generate RLS queries
    const queries = [
      `alter table ${resolvedTable} enable row level security`,
      `drop policy if exists ${policyName} on ${resolvedTable}`,
      `create policy ${policyName} on ${resolvedTable} for ${command} to ${roles}${usingClause}${withCheckClause}`
    ];

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
