import { IHookHandler } from "sa/testing";
import { PostgresFixture } from "sa/tools/postgres/postgres_fixture";

// Bypasses Docker if standard Postgres env variables or custom Supabase variables are set
const BYPASS_DOCKER = !!process.env.SUPABASE_HOST || !!process.env.PG_HOST || !!process.env.PG_CONNECTION_STRING;

export class SupabaseFixture {
  public static readonly host = BYPASS_DOCKER
    ? (process.env.SUPABASE_HOST || process.env.PG_HOST || "localhost")
    : PostgresFixture.host;

  public static readonly port = BYPASS_DOCKER
    ? (process.env.SUPABASE_PORT ? parseInt(process.env.SUPABASE_PORT, 10) : (process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432))
    : PostgresFixture.port;

  public static readonly user = BYPASS_DOCKER
    ? (process.env.SUPABASE_USER || process.env.PG_USER || "postgres")
    : PostgresFixture.user;

  public static readonly password = BYPASS_DOCKER
    ? (process.env.SUPABASE_PASSWORD || process.env.PG_PASSWORD || "password")
    : PostgresFixture.password;

  public static readonly database = BYPASS_DOCKER
    ? (process.env.SUPABASE_DATABASE || process.env.PG_DATABASE || "postgres")
    : PostgresFixture.database;

  private postgresFixture: PostgresFixture;

  constructor(port: number, setUp: IHookHandler, tearDown: IHookHandler) {
    // Inject Postgres env variables to automatically trigger bypass inside PostgresFixture
    if (BYPASS_DOCKER) {
      process.env.PG_HOST = SupabaseFixture.host;
      process.env.PG_PORT = String(SupabaseFixture.port);
      process.env.PG_USER = SupabaseFixture.user;
      process.env.PG_PASSWORD = SupabaseFixture.password;
      process.env.PG_DATABASE = SupabaseFixture.database;
    }
    // Standard PostgresFixture works beautifully as the underlying runner
    this.postgresFixture = new PostgresFixture(port, setUp, tearDown);
  }
}
