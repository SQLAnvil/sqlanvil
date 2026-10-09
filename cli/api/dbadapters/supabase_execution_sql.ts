import { Tasks } from "sa/cli/api/dbadapters/tasks";
import { PostgresExecutionSql } from "sa/cli/api/dbadapters/postgres_execution_sql";
import { sqlanvil } from "sa/protos/ts";

export class SupabaseExecutionSql extends PostgresExecutionSql {
  constructor(
    project: sqlanvil.IProjectConfig,
    sqlanvilCoreVersion: string,
    uniqueIdGenerator?: () => string
  ) {
    super(project, sqlanvilCoreVersion, uniqueIdGenerator);
  }

  public publishTasks(
    table: sqlanvil.ITable,
    runConfig: sqlanvil.IRunConfig,
    tableMetadata?: sqlanvil.ITableMetadata
  ): Tasks {
    // Postgres options may be nested under `supabase.postgres` instead of `postgres`.
    const nestedPostgres = table.supabase?.postgres;
    const effectiveTable = !table.postgres && nestedPostgres ? { ...table, postgres: nestedPostgres } : table;
    return super.publishTasks(effectiveTable, runConfig, tableMetadata);
  }

  // The table-level `supabase: {}` block. Every setting lives on the table itself, so it
  // only needs applying when the table is created; dropping the table also drops its RLS
  // flag, owner, vector indexes and publication membership.
  protected afterTableCreated(table: sqlanvil.ITable): string[] {
    const supabase = table.supabase;
    if (!supabase) {
      return [];
    }
    const target = this.resolveTarget(table.target);
    const statements: string[] = [];
    if (supabase.ownerRole) {
      statements.push(`alter table ${target} owner to "${supabase.ownerRole}"`);
    }
    if (supabase.enableRls) {
      statements.push(`alter table ${target} enable row level security`);
    }
    const vectors = supabase.vectors || [];
    if (vectors.length > 0) {
      statements.push("create extension if not exists vector cascade");
    }
    vectors.forEach(vector => {
      const params = vector.params || {};
      const indexType =
        vector.indexType === sqlanvil.SupabaseOptions.VectorConfig.IndexType.IVFFLAT
          ? "ivfflat"
          : "hnsw";
      const opclass = params.opclass || "vector_cosine_ops";
      const withOptions = Object.entries(params)
        .filter(([key]) => key !== "opclass")
        .map(([key, value]) => `${key} = ${value}`);
      const withClause = withOptions.length > 0 ? ` with (${withOptions.join(", ")})` : "";
      const indexName = this.defaultIndexName(table.target.name, [vector.column], false);
      statements.push(
        `create index "${indexName}" on ${target} using ${indexType} ("${vector.column}" ${opclass})${withClause}`
      );
    });
    if (supabase.publishToRealtime) {
      statements.push(`alter table ${target} replica identity full`);
      statements.push(`alter publication supabase_realtime add table ${target}`);
    }
    return statements;
  }
}
