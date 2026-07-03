import * as fs from "fs-extra";
import * as path from "path";

import * as mysql from "mysql2/promise";
import * as pg from "pg";
import { BigQuery } from "@google-cloud/bigquery";

import { readConfigFromWorkflowSettings } from "sa/cli/api/utils";

export interface NormalizedColumn {
  name: string;
  type: string;
  description?: string;
}

const BIGQUERY_TYPE_MAP: { [bq: string]: string } = {
  STRING: "text",
  BYTES: "bytea",
  INT64: "bigint",
  INTEGER: "bigint",
  FLOAT64: "float8",
  FLOAT: "float8",
  NUMERIC: "numeric",
  BIGNUMERIC: "numeric",
  BOOL: "boolean",
  BOOLEAN: "boolean",
  TIMESTAMP: "timestamptz",
  DATETIME: "timestamp",
  DATE: "date",
  TIME: "time",
  JSON: "jsonb",
  GEOGRAPHY: "text"
};

export function mapBigQueryType(bqType: string): string {
  const key = bqType.trim().toUpperCase();
  const mapped = BIGQUERY_TYPE_MAP[key];
  if (!mapped) {
    throw new Error(
      `Unmapped BigQuery type "${bqType}". Add it to BIGQUERY_TYPE_MAP or set the column type by hand.`
    );
  }
  return mapped;
}

export function mapPostgresType(pgType: string): string {
  // Postgres source -> Postgres warehouse: identity (information_schema already
  // reports a valid Postgres type name).
  return pgType.trim().toLowerCase();
}

// MySQL source -> Postgres warehouse. columnTypes on a connection'd declaration define the
// bridge/extract table's columns IN THE WRITE WAREHOUSE (always Postgres/Supabase — a mysql
// warehouse can't read connections), so raw MySQL names like "datetime" or "double" would fail
// the extract's CREATE TABLE. Types spelled the same in both dialects pass through unmapped.
const MYSQL_TYPE_MAP: { [key: string]: string } = {
  tinyint: "smallint",
  mediumint: "integer",
  int: "integer",
  double: "double precision",
  float: "real",
  decimal: "numeric",
  bit: "smallint",
  year: "smallint",
  datetime: "timestamp",
  // MySQL TIMESTAMP is UTC-normalized on the wire; timestamptz preserves that.
  timestamp: "timestamptz",
  char: "text",
  varchar: "text",
  tinytext: "text",
  mediumtext: "text",
  longtext: "text",
  enum: "text",
  set: "text",
  binary: "bytea",
  varbinary: "bytea",
  tinyblob: "bytea",
  blob: "bytea",
  mediumblob: "bytea",
  longblob: "bytea",
  json: "jsonb",
  geometry: "text"
};

export function mapMysqlType(mysqlType: string): string {
  const key = mysqlType.trim().toLowerCase();
  return MYSQL_TYPE_MAP[key] || key;
}

export interface RenderDeclarationOptions {
  connection: string;
  schema?: string;
  name: string;
  columns: NormalizedColumn[];
}

function keyToken(name: string): string {
  // Bare key if a valid JS identifier, else a double-quoted string key.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderDeclarationSqlx(opts: RenderDeclarationOptions): string {
  const lines: string[] = [];
  lines.push("config {");
  lines.push(`  type: "declaration",`);
  lines.push(`  connection: ${quote(opts.connection)},`);
  if (opts.schema) {
    lines.push(`  schema: ${quote(opts.schema)},`);
  }
  lines.push(`  name: ${quote(opts.name)},`);

  const typeLines = opts.columns.map(function(c) { return `    ${keyToken(c.name)}: ${quote(c.type)}`; });
  const described = opts.columns.filter(function(c) { return !!c.description; });
  lines.push(`  columnTypes: {`);
  lines.push(typeLines.join(",\n"));
  lines.push(described.length > 0 ? `  },` : `  }`);

  if (described.length > 0) {
    const descLines = described.map(function(c) { return `    ${keyToken(c.name)}: ${quote(c.description!)}`; });
    lines.push(`  columns: {`);
    lines.push(descLines.join(",\n"));
    lines.push(`  }`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

export interface ResolvedConnection {
  name: string;
  definition: any; // ConnectionConfig: { platform, project, dataset, saKeyId, host, port, database, defaultSchema }
  credentials: any; // secrets from .df-credentials.json for this connection
}

export function resolveConnection(projectDir: string, connectionName: string): ResolvedConnection {
  const workflowSettings = readConfigFromWorkflowSettings(path.resolve(projectDir));
  const definition =
    workflowSettings && workflowSettings.connections
      ? workflowSettings.connections[connectionName]
      : undefined;
  if (!definition) {
    throw new Error(
      `Unknown connection "${connectionName}". Define it under \`connections:\` in workflow_settings.yaml.`
    );
  }
  const credsPath = path.join(path.resolve(projectDir), ".df-credentials.json");
  if (!fs.existsSync(credsPath)) {
    throw new Error(`Missing .df-credentials.json in ${projectDir}.`);
  }
  const allCreds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  // Source-connection credentials live under the `connections` map (keyed by name),
  // so the warehouse credentials can stay flat at the top level for `run` to read.
  const credentials = allCreds.connections && allCreds.connections[connectionName];
  if (!credentials) {
    throw new Error(
      `No credentials for connection "${connectionName}" in .df-credentials.json ` +
        `(expected a "connections.${connectionName}" entry).`
    );
  }
  return { name: connectionName, definition, credentials };
}

// A reader returns the source table's columns with RAW source-platform type names.
export type SchemaReader = (
  resolved: ResolvedConnection,
  sourceSchema: string,
  table: string
) => Promise<NormalizedColumn[]>;

export const readPostgresSchema: SchemaReader = function(resolved, sourceSchema, table) {
  const c = resolved.credentials;
  const client = new pg.Client({
    host: c.host || resolved.definition.host,
    port: Number(c.port || resolved.definition.port || 5432),
    database: c.database || resolved.definition.database,
    user: c.user,
    password: c.password,
    ssl: c.sslMode && c.sslMode !== "disable" ? { rejectUnauthorized: false } : undefined
  });
  return client
    .connect()
    .then(function() {
      return client.query(
        `select a.attname as column_name,
                format_type(a.atttypid, a.atttypmod) as data_type,
                col_description(a.attrelid, a.attnum) as description
         from pg_attribute a
         where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
           and a.attnum > 0 and not a.attisdropped
         order by a.attnum`,
        [sourceSchema, table]
      );
    })
    .then(function(res) {
      return res.rows.map(function(r: any) {
        return { name: r.column_name, type: r.data_type, description: r.description || undefined };
      });
    })
    .then(
      function(cols) {
        return client.end().then(function() {
          return cols;
        });
      },
      function(err) {
        return client.end().then(
          function() { throw err; },
          function() { throw err; }
        );
      }
    );
};

export const readBigQuerySchema: SchemaReader = function(resolved, sourceSchema, table) {
  const keyJson = resolved.credentials.credentials;
  const bq = new BigQuery({
    projectId: resolved.definition.project,
    credentials: typeof keyJson === "string" ? JSON.parse(keyJson) : keyJson
  });
  return bq
    .dataset(sourceSchema)
    .table(table)
    .getMetadata()
    .then(function(result: any) {
      const metadata = result[0];
      const fields: any[] = (metadata && metadata.schema && metadata.schema.fields) || [];
      return fields.map(function(f) {
        return { name: f.name, type: f.type, description: f.description || undefined };
      });
    });
};

export const readMysqlSchema: SchemaReader = function(resolved, sourceSchema, table) {
  const c = resolved.credentials;
  let conn: any;
  return mysql
    .createConnection({
      host: c.host || resolved.definition.host,
      port: Number(c.port || resolved.definition.port || 3306),
      database: c.database || resolved.definition.database,
      user: c.user,
      password: c.password,
      ssl: c.sslMode && c.sslMode !== "disable" ? { rejectUnauthorized: false } : undefined
    })
    .then(function(connection) {
      conn = connection;
      // MySQL has no catalog level — the "schema" is the database (table_schema).
      return conn.query(
        `select column_name, data_type, column_comment
         from information_schema.columns
         where table_schema = ? and table_name = ?
         order by ordinal_position`,
        [sourceSchema, table]
      );
    })
    .then(function(result: any) {
      const rows: any[] = result[0] || [];
      return rows.map(function(r) {
        // mysql2 preserves the SELECTed (lowercase) labels, but guard for upper-case too.
        const name = r.column_name !== undefined ? r.column_name : r.COLUMN_NAME;
        const type = r.data_type !== undefined ? r.data_type : r.DATA_TYPE;
        const comment = r.column_comment !== undefined ? r.column_comment : r.COLUMN_COMMENT;
        return { name, type, description: comment || undefined };
      });
    })
    .then(
      function(cols) {
        return conn.end().then(function() { return cols; });
      },
      function(err) {
        return (conn ? conn.end() : Promise.resolve()).then(
          function() { throw err; },
          function() { throw err; }
        );
      }
    );
};

function defaultReaderFor(platform: string): SchemaReader {
  if (platform === "bigquery") {
    return readBigQuerySchema;
  }
  if (platform === "postgres" || platform === "supabase") {
    return readPostgresSchema;
  }
  if (platform === "mysql") {
    return readMysqlSchema;
  }
  throw new Error(`introspect does not support source platform "${platform}".`);
}

function splitTableRef(tableRef: string): { schema?: string; table: string } {
  const dot = tableRef.indexOf(".");
  return dot === -1
    ? { table: tableRef }
    : { schema: tableRef.slice(0, dot), table: tableRef.slice(dot + 1) };
}

export interface IntrospectOptions {
  reader?: SchemaReader;
}

export function introspectToSqlx(
  projectDir: string,
  connectionName: string,
  tableRef: string,
  options?: IntrospectOptions
): Promise<string> {
  const opts = options || {};
  const resolved = resolveConnection(projectDir, connectionName);
  const parts = splitTableRef(tableRef);
  const reader = opts.reader || defaultReaderFor(resolved.definition.platform);
  const sourceSchema =
    parts.schema || resolved.definition.dataset || resolved.definition.defaultSchema;
  if (!sourceSchema) {
    return Promise.reject(new Error(
      `Could not determine the source schema for "${tableRef}" on connection "${connectionName}". ` +
        `Pass it as "schema.table", or set "dataset"/"defaultSchema" on the connection.`
    ));
  }
  const mapType =
    resolved.definition.platform === "bigquery"
      ? mapBigQueryType
      : resolved.definition.platform === "mysql"
      ? mapMysqlType
      : mapPostgresType;
  return reader(resolved, sourceSchema, parts.table).then(function(rawColumns) {
    if (rawColumns.length === 0) {
      throw new Error(
        `Source table "${tableRef}" on connection "${connectionName}" has no columns (does it exist?).`
      );
    }
    const columns = rawColumns.map(function(col) {
      return { name: col.name, type: mapType(col.type), description: col.description };
    });
    return renderDeclarationSqlx({
      connection: connectionName,
      schema: parts.schema,
      name: parts.table,
      columns
    });
  });
}
