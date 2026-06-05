import * as pg from "pg";

import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { PgPoolExecutor } from "sa/cli/api/utils/postgres";
import { ErrorWithCause } from "sa/common/errors/errors";
import { sqlanvil } from "sa/protos/ts";

export class SupabaseDbAdapter extends PostgresDbAdapter {
  public static async create(
    credentials: sqlanvil.IPostgresConnection,
    options?: { concurrencyLimit?: number; disableSslForTestsOnly?: boolean }
  ): Promise<SupabaseDbAdapter> {
    const sslMode = (credentials.sslMode || "").toLowerCase();
    const sslEnabled = !options?.disableSslForTestsOnly && sslMode !== "disable";
    const clientConfig: pg.ClientConfig = {
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.user,
      password: credentials.password,
      ssl: sslEnabled
        ? {
            rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full"
          }
        : false
    };
    const queryExecutor = new PgPoolExecutor(clientConfig, options);
    // Fail fast on a single connection before any command fans out, so a bad
    // credential/host yields one clean error instead of N parallel auth failures
    // (which trip Supabase's pooler circuit breaker).
    try {
      await queryExecutor.verifyConnection();
    } catch (e) {
      await queryExecutor.close().catch(() => undefined);
      throw new ErrorWithCause(
        `Could not connect to Supabase Postgres at ${credentials.host}:${credentials.port} ` +
          `as "${credentials.user}": ${e.message}`,
        e
      );
    }
    return new SupabaseDbAdapter(queryExecutor);
  }

  protected constructor(queryExecutor: PgPoolExecutor) {
    super(queryExecutor);
  }

  public async verifyServiceRolePermissions(): Promise<boolean> {
    try {
      const result = await this.execute("select current_user");
      const currentUser = result.rows[0]?.current_user;
      return !!currentUser;
    } catch {
      return false;
    }
  }

  public async validatePublicationState(pubName: string = "supabase_realtime"): Promise<boolean> {
    try {
      const result = await this.execute(`select 1 from pg_publication where pubname = $1`, {
        params: [pubName]
      });
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }
}
