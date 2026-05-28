import { sqlanvil } from "sa/protos/ts";

export class CompilationSql {
  constructor(
    private readonly project: sqlanvil.IProjectConfig,
    private readonly sqlanvilCoreVersion: string
  ) {}

  private get warehouse(): string {
    return (this.project.warehouse || "bigquery").toLowerCase();
  }

  public resolveTarget(target: sqlanvil.ITarget) {
    const database = target.database || this.project.defaultDatabase;
    const schema = target.schema || this.project.defaultSchema;
    const name = target.name;

    if (this.warehouse === "postgres" || this.warehouse === "supabase") {
      // Postgres/Supabase standard double-quoting dialect: "schema"."name" or "database"."schema"."name"
      if (!database) {
        return `"${schema}"."${name}"`;
      }
      return `"${database}"."${schema}"."${name}"`;
    }

    // Default to BigQuery backtick dialect: `database.schema.name`
    if (!database) {
      return `\`${schema}.${name}\``;
    }
    return `\`${database}.${schema}.${name}\``;
  }

  public sqlString(stringContents: string) {
    if (this.warehouse === "postgres" || this.warehouse === "supabase") {
      // Postgres/ANSI SQL standard single quote escaping (doubling up single quotes)
      return `'${stringContents.replace(/'/g, "''")}'`;
    }
    // BigQuery backslash-based single quote escaping
    return `'${stringContents.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }

  public indexAssertion(dataset: string, indexCols: string[]) {
    const quoteCol = (col: string) => {
      if (this.warehouse === "postgres" || this.warehouse === "supabase") {
        // Double quote columns to handle case sensitivity and reserved SQL keywords
        return `"${col.replace(/"/g, '""')}"`;
      }
      return col;
    };
    const commaSeparatedColumns = indexCols.map(quoteCol).join(", ");
    return `
SELECT
  *
FROM (
  SELECT
    ${commaSeparatedColumns},
    COUNT(1) AS index_row_count
  FROM ${dataset}
  GROUP BY ${commaSeparatedColumns}
  ) AS data
WHERE index_row_count > 1
`;
  }

  public rowConditionsAssertion(dataset: string, rowConditions: string[]) {
    return rowConditions
      .map(
        (rowCondition: string) => `
SELECT
  ${this.sqlString(rowCondition)} AS failing_row_condition,
  *
FROM ${dataset}
WHERE NOT (${rowCondition})
`
      )
      .join(`UNION ALL`);
  }
}

