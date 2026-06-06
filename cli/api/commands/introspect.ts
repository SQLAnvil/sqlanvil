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
