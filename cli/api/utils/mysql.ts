import * as mysql from "mysql2/promise";

import { sqlanvil } from "sa/protos/ts";

// Connection-pool lifecycle for MySQL/MariaDB via mysql2. Mirrors PgPoolExecutor:
// fail-fast verifyConnection, a withClientLock that leases a single connection
// for a unit of work, and a single release path (the #32 release-once discipline
// baked in from the start — a double release here would surface a confusing
// pool error ahead of the real query error).
export class MySqlPoolExecutor {
  private pool: mysql.Pool;

  constructor(config: mysql.PoolOptions, options?: { concurrencyLimit?: number }) {
    this.pool = mysql.createPool({
      ...config,
      connectionLimit: options?.concurrencyLimit || 10,
      waitForConnections: true,
      // Generated SQL runs one statement per task; disabling multi-statement
      // execution keeps a single bad statement from chaining unexpected effects.
      multipleStatements: false
    });
  }

  /**
   * Acquire a single connection and run a trivial query to verify the
   * credentials/host before any real work fans out. Connecting is where auth
   * happens, so a bad password/host fails here with one connection attempt
   * rather than N parallel auth failures.
   */
  public async verifyConnection(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query("select 1");
    } finally {
      conn.release();
    }
  }

  public async withClientLock<T>(
    callback: (client: {
      execute(statement: string, options?: { params?: any[]; rowLimit?: number }): Promise<any[]>;
    }) => Promise<T>
  ): Promise<T> {
    const conn = await this.pool.getConnection();
    // Release exactly once — from the finally below. A second release would trip
    // mysql2's pool accounting and mask the real error.
    let released = false;
    const releaseOnce = () => {
      if (released) {
        return;
      }
      released = true;
      conn.release();
    };
    try {
      return await callback({
        execute: async (
          statement: string,
          options: { params?: any[]; rowLimit?: number } = { rowLimit: 1000 }
        ): Promise<any[]> => {
          const [rows] = await conn.query(statement, options.params || []);
          const arr = Array.isArray(rows) ? (rows as any[]) : [];
          // mysql2 buffers the full result set (no streaming cursor), so rowLimit
          // is applied client-side after the fetch. byteLimit is not enforced here
          // — unlike the Postgres adapter's streaming LimitedResultSet.
          return options.rowLimit && arr.length > options.rowLimit
            ? arr.slice(0, options.rowLimit)
            : arr;
        }
      });
    } finally {
      releaseOnce();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

// Maps MySQL/MariaDB information_schema.columns DATA_TYPE values to sqlanvil
// field primitives. DATA_TYPE excludes the length/precision suffix, so no
// stripping is needed (unlike Postgres's format_type).
export function convertFieldType(type: string) {
  switch (String(type).toUpperCase()) {
    case "FLOAT":
    case "DOUBLE":
    case "REAL":
      return sqlanvil.Field.Primitive.FLOAT;
    case "TINYINT":
    case "SMALLINT":
    case "MEDIUMINT":
    case "INT":
    case "INTEGER":
    case "BIGINT":
    case "YEAR":
    case "BIT":
      return sqlanvil.Field.Primitive.INTEGER;
    case "DECIMAL":
    case "DEC":
    case "NUMERIC":
    case "FIXED":
      return sqlanvil.Field.Primitive.NUMERIC;
    case "BOOL":
    case "BOOLEAN":
      return sqlanvil.Field.Primitive.BOOLEAN;
    case "CHAR":
    case "VARCHAR":
    case "TINYTEXT":
    case "TEXT":
    case "MEDIUMTEXT":
    case "LONGTEXT":
    case "ENUM":
    case "SET":
    case "JSON":
    case "TIME":
      return sqlanvil.Field.Primitive.STRING;
    case "DATE":
      return sqlanvil.Field.Primitive.DATE;
    case "DATETIME":
    case "TIMESTAMP":
      return sqlanvil.Field.Primitive.TIMESTAMP;
    // BINARY/VARBINARY, the BLOB family, and GEOMETRY have no field primitive;
    // they fall through to UNKNOWN (introspection metadata only).
    default:
      return sqlanvil.Field.Primitive.UNKNOWN;
  }
}
