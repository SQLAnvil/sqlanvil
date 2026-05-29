import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IVectorIndexConfig {
  name: string;
  table: string;
  column: string;
  dimensions?: number;
  indexType?: string; // hnsw or ivfflat
  params?: { [key: string]: string };
  filename?: string;
}

export class VectorIndex extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IVectorIndexConfig;

  constructor(session: Session, config: IVectorIndexConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const tableTarget = this.applySessionToTarget(sqlanvil.Target.create({ name: config.table }), session.projectConfig);
    const target = sqlanvil.Target.create({ name: `${config.table}_idx_${config.name}` });
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

    const opclass = this.config.params?.opclass || "vector_cosine_ops";
    const indexType = this.config.indexType ? this.config.indexType.toLowerCase() : "hnsw";

    // Filter out opclass from other pgvector parameters
    const withOptionsArray: string[] = [];
    if (this.config.params) {
      for (const [key, val] of Object.entries(this.config.params)) {
        if (key !== "opclass") {
          withOptionsArray.push(`${key} = ${val}`);
        }
      }
    }
    const withStr = withOptionsArray.length > 0 ? ` with (${withOptionsArray.join(", ")})` : "";

    // Generate vector index queries
    const queries = [
      `create extension if not exists vector cascade`,
      `drop index if exists "${this.config.name}"`,
      `create index "${this.config.name}" on ${resolvedTable} using ${indexType} ("${this.config.column}" ${opclass})${withStr}`
    ];

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
