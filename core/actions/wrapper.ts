import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IWrapperConfig {
  name: string;
  wrapper: string;
  server: string;
  options?: { [key: string]: string };
  filename?: string;
}

export class Wrapper extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IWrapperConfig;

  constructor(session: Session, config: IWrapperConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, { validateTarget: true });
    this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
    this.proto.fileName = config.filename || "";
  }

  public getFileName() {
    return this.proto.fileName;
  }

  public getTarget() {
    return sqlanvil.Target.create(this.proto.target);
  }

  public compile() {
    const optionsArray: string[] = [];
    if (this.config.options) {
      for (const [key, val] of Object.entries(this.config.options)) {
        optionsArray.push(`${key} '${val}'`);
      }
    }
    const optionsStr = optionsArray.length > 0 ? ` options (${optionsArray.join(", ")})` : "";

    // Generate FDW extension and server queries
    const queries = [
      `create extension if not exists "${this.config.wrapper}" cascade`,
      `drop server if exists "${this.config.server}" cascade`,
      `create server "${this.config.server}" foreign data wrapper "${this.config.wrapper}"${optionsStr}`
    ];

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
