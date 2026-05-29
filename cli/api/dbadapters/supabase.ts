import * as pg from "pg";

import { PostgresDbAdapter } from "sa/cli/api/dbadapters/postgres";
import { PgPoolExecutor } from "sa/cli/api/utils/postgres";
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
