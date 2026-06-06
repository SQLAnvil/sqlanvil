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
