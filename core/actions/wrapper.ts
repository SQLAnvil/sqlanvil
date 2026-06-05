import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "sa/common/protos";
import { ActionBuilder } from "sa/core/actions/base";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export interface IForeignTableConfigEntry {
  name: string;
  schema?: string;
  options?: { [key: string]: string };
  columns?: { [key: string]: string };
}

export interface IWrapperCredential {
  // Supabase: id of a pre-existing Vault secret holding the SA key JSON (a
  // non-secret pointer). The key JSON itself is never handled by SQLAnvil.
  saKeyId?: string;
  // Reserved for plain-Postgres CREATE USER MAPPING. NOT YET IMPLEMENTED —
  // these are currently ignored; only the Supabase Vault `saKeyId` path emits credentials.
  user?: string;
  password?: string;
}

export interface IWrapperConfig {
  name: string;
  provider?: string;
  wrapper?: string;
  handler?: string;
  validator?: string;
  server: string;
  serverOptions?: { [key: string]: string };
  /** @deprecated Use `serverOptions` instead. Retained for back-compat. */
  options?: { [key: string]: string };
  credential?: IWrapperCredential;
  // Foreign tables to expose via this server. Expanded into ref-able ForeignTable
  // actions by session.wrapper(); not emitted by this action's compile().
  foreignTables?: IForeignTableConfigEntry[];
  filename?: string;
}

interface IProviderPreset {
  extension: string;
  wrapper: string;
  handler: string;
  validator: string;
}

export const WRAPPER_PROVIDERS: { [name: string]: IProviderPreset } = {
  bigquery: {
    extension: "wrappers",
    wrapper: "bigquery_wrapper",
    handler: "big_query_fdw_handler",
    validator: "big_query_fdw_validator"
  }
};

export interface IResolvedWrapper {
  extension: string;
  wrapper: string;
  handler?: string;
  validator?: string;
}

export function resolveWrapper(config: IWrapperConfig): IResolvedWrapper {
  if (config.provider) {
    const preset = WRAPPER_PROVIDERS[config.provider];
    if (!preset) {
      throw new Error(
        `Unknown wrapper provider "${config.provider}". Supported providers: ${Object.keys(
          WRAPPER_PROVIDERS
        ).join(", ")}.`
      );
    }
    return preset;
  }
  if (!config.wrapper) {
    throw new Error(
      `wrapper "${config.name}" must set either "provider" or an explicit "wrapper" extension name.`
    );
  }
  if (!config.handler || !config.validator) {
    throw new Error(
      `wrapper "${config.name}" without a "provider" preset must also set "handler" and "validator".`
    );
  }
  return {
    extension: config.wrapper,
    wrapper: config.wrapper,
    handler: config.handler,
    validator: config.validator
  };
}

export class Wrapper extends ActionBuilder<sqlanvil.Operation> {
  private proto = sqlanvil.Operation.create();
  private config: IWrapperConfig;

  constructor(session: Session, config: IWrapperConfig) {
    super(session);
    this.session = session;
    this.config = config;

    const target = sqlanvil.Target.create({ name: config.name });
    this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
      validateTarget: true
    });
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
    const resolved = resolveWrapper(this.config);

    const serverOptionsMap = { ...(this.config.serverOptions || this.config.options || {}) };
    if (this.config.credential && this.config.credential.saKeyId) {
      serverOptionsMap.sa_key_id = this.config.credential.saKeyId;
    }
    const optionsArray = Object.entries(serverOptionsMap).map(
      ([k, v]) => `${k} '${String(v).replace(/'/g, "''")}'`
    );
    const optionsStr = optionsArray.length > 0 ? ` options (${optionsArray.join(", ")})` : "";

    const queries = [`create extension if not exists "${resolved.extension}" cascade`];
    if (resolved.handler && resolved.validator) {
      queries.push(
        `do $$ begin if not exists (select 1 from pg_foreign_data_wrapper where fdwname = '${resolved.wrapper}') then create foreign data wrapper ${resolved.wrapper} handler ${resolved.handler} validator ${resolved.validator}; end if; end $$`
      );
    }
    queries.push(`drop server if exists "${this.config.server}" cascade`);
    queries.push(
      `create server "${this.config.server}" foreign data wrapper "${resolved.wrapper}"${optionsStr}`
    );

    this.proto.queries = queries;

    return verifyObjectMatchesProto(
      sqlanvil.Operation,
      this.proto,
      VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
    );
  }
}
