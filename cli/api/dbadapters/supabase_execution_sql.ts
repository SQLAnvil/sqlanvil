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
}
