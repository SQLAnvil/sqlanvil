import { collectEvaluationQueries, QueryOrAction } from "sa/cli/api/dbadapters/execution_sql";
import {
  IDbAdapter,
  IDbClient,
  IExecutionResult,
  IExecutionResultRaw,
  OnCancel
} from "sa/cli/api/dbadapters/index";
import {
  convertFieldType,
  escapeMysqlString,
  MySqlPoolExecutor,
  reconstructColumnDef
} from "sa/cli/api/utils/mysql";
import { ErrorWithCause } from "sa/common/errors/errors";
import { sqlanvil } from "sa/protos/ts";

// MySQL/MariaDB has no catalog level above the database, so "schema" and
// "database" are the same thing — these are the engine-managed databases we
// never treat as user schemas.
const INTERNAL_SCHEMAS = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys"
]);

export class MySqlDbAdapter implements IDbAdapter {
  public static async create(
    credentials: sqlanvil.IMysqlConnection,
    options?: { concurrencyLimit?: number; disableSslForTestsOnly?: boolean }
  ): Promise<MySqlDbAdapter> {
    const sslMode = (credentials.sslMode || "").toLowerCase();
    const ssl =
      !options?.disableSslForTestsOnly && sslMode && sslMode !== "disable"
        ? // Managed MySQL providers serve certs signed by their own CA; skipping
          // verification is the documented path for sslmode=require. Stricter
          // verification would need a CA bundle we don't ship today.
          { rejectUnauthorized: false }
        : undefined;
    const queryExecutor = new MySqlPoolExecutor(
      {
        host: credentials.host,
        port: credentials.port || 3306,
        user: credentials.user,
        password: credentials.password,
        database: credentials.database || undefined,
        ssl
      },
      options
    );
    // Fail fast on a single connection before any command fans out.
    try {
      await queryExecutor.verifyConnection();
    } catch (e) {
      await queryExecutor.close().catch(() => undefined);
      throw new ErrorWithCause(
        `Could not connect to MySQL at ${credentials.host}:${credentials.port || 3306} ` +
          `as "${credentials.user}": ${e.message}`,
        e
      );
    }
    return new MySqlDbAdapter(queryExecutor);
  }

  protected constructor(protected readonly queryExecutor: MySqlPoolExecutor) {}

  public async execute(
    statement: string,
    options: {
      params?: any[];
      onCancel?: OnCancel;
      rowLimit?: number;
      byteLimit?: number;
      includeQueryInError?: boolean;
    } = { rowLimit: 1000, byteLimit: 1024 * 1024 }
  ): Promise<IExecutionResult> {
    return await this.withClientLock(client => client.execute(statement, options));
  }

  public async executeRaw(
    statement: string,
    options: {
      params?: any[];
      rowLimit?: number;
    } = { rowLimit: 1000 }
  ): Promise<IExecutionResultRaw> {
    const result = await this.execute(statement, options);
    return { ...result, schema: [] };
  }

  public async withClientLock<T>(callback: (client: IDbClient) => Promise<T>): Promise<T> {
    return await this.queryExecutor.withClientLock(client =>
      callback({
        execute: async (
          stmt: string,
          opts: {
            params?: any[];
            onCancel?: OnCancel;
            rowLimit?: number;
            byteLimit?: number;
            includeQueryInError?: boolean;
          } = { rowLimit: 1000, byteLimit: 1024 * 1024 }
        ): Promise<IExecutionResult> => {
          try {
            const rows = await client.execute(stmt, { params: opts.params, rowLimit: opts.rowLimit });
            return { rows, metadata: {} };
          } catch (e) {
            if (opts.includeQueryInError) {
              throw new Error(`Error encountered while running "${stmt}": ${e.message}`);
            }
            throw new ErrorWithCause(`Error executing mysql query: ${e.message}`, e);
          }
        },
        executeRaw: async (
          stmt: string,
          opts: { params?: { [name: string]: any }; rowLimit?: number } = { rowLimit: 1000 }
        ): Promise<IExecutionResultRaw> => {
          const positional = opts.params ? Object.values(opts.params) : undefined;
          const rows = await client.execute(stmt, { params: positional, rowLimit: opts.rowLimit });
          return { rows, schema: [], metadata: {} };
        }
      })
    );
  }

  public async evaluate(queryOrAction: QueryOrAction): Promise<sqlanvil.IQueryEvaluation[]> {
    // EXPLAIN parses + plans without executing, catching syntax errors and
    // missing tables/columns.
    const validationQueries = collectEvaluationQueries(queryOrAction, false, (query: string) =>
      !!query ? `explain ${query}` : ""
    ).map((validationQuery, index) => ({ index, validationQuery }));
    const validationQueriesWithoutWrappers = collectEvaluationQueries(queryOrAction, false);

    const queryEvaluations = new Array<sqlanvil.IQueryEvaluation>();
    for (const { index, validationQuery } of validationQueries) {
      let evaluationResponse: sqlanvil.IQueryEvaluation = {
        status: sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      };
      try {
        await this.execute(validationQuery.query);
      } catch (e) {
        evaluationResponse = {
          status: sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE,
          error: sqlanvil.QueryEvaluationError.create({
            message: e?.message ? String(e.message) : String(e)
          })
        };
      }
      queryEvaluations.push(
        sqlanvil.QueryEvaluation.create({
          ...evaluationResponse,
          incremental: validationQuery.incremental,
          query: validationQueriesWithoutWrappers[index].query
        })
      );
    }
    return queryEvaluations;
  }

  public async tables(_database: string, schema?: string): Promise<sqlanvil.ITableMetadata[]> {
    const params: any[] = [];
    let schemaClause = "";
    if (schema) {
      schemaClause = "and table_schema = ?";
      params.push(schema);
    }
    const queryResult = await this.execute(
      `select table_name, table_schema
       from information_schema.tables
       where table_schema not in ('information_schema', 'mysql', 'performance_schema', 'sys')
       ${schemaClause}`,
      { params, rowLimit: 10000, includeQueryInError: true }
    );
    const targets = queryResult.rows.map(row => ({
      schema: row.table_schema as string,
      name: row.table_name as string
    }));
    return await Promise.all(targets.map(target => this.table(target)));
  }

  public async search(
    searchText: string,
    options: { limit: number } = { limit: 1000 }
  ): Promise<sqlanvil.ITableMetadata[]> {
    const results = await this.execute(
      `select tables.table_schema as table_schema, tables.table_name as table_name
       from information_schema.tables as tables
       left join information_schema.columns columns
         on tables.table_schema = columns.table_schema
         and tables.table_name = columns.table_name
       where tables.table_schema like ?
          or tables.table_name like ?
          or columns.column_name like ?
       group by 1, 2`,
      {
        params: [`%${searchText}%`, `%${searchText}%`, `%${searchText}%`],
        rowLimit: options.limit
      }
    );
    return await Promise.all(
      results.rows.map(row =>
        this.table({
          schema: row.table_schema,
          name: row.table_name
        })
      )
    );
  }

  public async table(target: sqlanvil.ITarget): Promise<sqlanvil.ITableMetadata> {
    const params = [target.schema, target.name];
    const [tableResults, columnResults] = await Promise.all([
      this.execute(
        `select table_type, table_comment from information_schema.tables
         where table_schema = ? and table_name = ?`,
        { params, includeQueryInError: true }
      ),
      this.execute(
        `select column_name, data_type, ordinal_position, column_comment
         from information_schema.columns
         where table_schema = ? and table_name = ?
         order by ordinal_position`,
        { params, includeQueryInError: true }
      )
    ]);

    if (tableResults.rows.length === 0) {
      return null;
    }

    // mysql2 returns information_schema column names in their canonical
    // upper/lower case depending on server config; normalise via lower-cased keys.
    const tableType = String(
      tableResults.rows[0].table_type ?? tableResults.rows[0].TABLE_TYPE
    ).toUpperCase();
    const tableComment = String(
      tableResults.rows[0].table_comment ?? tableResults.rows[0].TABLE_COMMENT ?? ""
    );
    return sqlanvil.TableMetadata.create({
      target,
      type: tableType === "VIEW" ? sqlanvil.TableMetadata.Type.VIEW : sqlanvil.TableMetadata.Type.TABLE,
      description: tableComment || undefined,
      fields: columnResults.rows.map(row => {
        const comment = String(row.column_comment ?? row.COLUMN_COMMENT ?? "");
        return sqlanvil.Field.create({
          name: (row.column_name ?? row.COLUMN_NAME) as string,
          primitive: convertFieldType((row.data_type ?? row.DATA_TYPE) as string),
          description: comment || undefined
        });
      })
    });
  }

  public async deleteTable(target: sqlanvil.ITarget): Promise<void> {
    const metadata = await this.table(target);
    if (!metadata) {
      return;
    }
    const kind = metadata.type === sqlanvil.TableMetadata.Type.VIEW ? "view" : "table";
    await this.execute(`drop ${kind} if exists \`${target.schema}\`.\`${target.name}\``, {
      includeQueryInError: true
    });
  }

  public async schemas(_database: string): Promise<string[]> {
    const result = await this.execute(`select schema_name from information_schema.schemata`, {
      includeQueryInError: true
    });
    return result.rows
      .map(row => (row.schema_name ?? row.SCHEMA_NAME) as string)
      .filter(name => !INTERNAL_SCHEMAS.has(name));
  }

  public async createSchema(_database: string, schema: string): Promise<void> {
    await this.execute(`create database if not exists \`${schema}\``, {
      includeQueryInError: true
    });
  }

  public async setMetadata(action: sqlanvil.IExecutionAction): Promise<void> {
    const { target, actionDescriptor } = action;
    const actualMetadata = await this.table(target);
    if (!actualMetadata) {
      return;
    }
    // MySQL views cannot carry table or column comments — skip them.
    if (actualMetadata.type === sqlanvil.TableMetadata.Type.VIEW) {
      return;
    }
    const resolved = `\`${target.schema}\`.\`${target.name}\``;

    // Table comment (standalone statement).
    if (actionDescriptor?.description) {
      await this.execute(
        `alter table ${resolved} comment = '${escapeMysqlString(actionDescriptor.description)}'`,
        { includeQueryInError: true }
      );
    }

    // Column comments require MODIFY COLUMN with the full reconstructed definition
    // (MySQL has no standalone column-comment statement, and MODIFY rewrites the
    // whole column).
    const columnComments = (actionDescriptor?.columns || []).filter(
      column =>
        column.path?.length === 1 && actualMetadata.fields.some(f => f.name === column.path[0])
    );
    if (columnComments.length === 0) {
      return;
    }
    const defResult = await this.execute(
      `select column_name, column_type, is_nullable, column_default, extra,
              collation_name, generation_expression
       from information_schema.columns
       where table_schema = ? and table_name = ?`,
      { params: [target.schema, target.name], includeQueryInError: true }
    );
    const defByName = new Map<string, any>();
    defResult.rows.forEach(row => defByName.set(String(row.column_name ?? row.COLUMN_NAME), row));
    for (const column of columnComments) {
      const name = column.path[0];
      const row = defByName.get(name);
      if (!row) {
        continue;
      }
      const def = reconstructColumnDef({
        columnType: String(row.column_type ?? row.COLUMN_TYPE),
        isNullable: String(row.is_nullable ?? row.IS_NULLABLE),
        columnDefault:
          (row.column_default ?? row.COLUMN_DEFAULT ?? null) === null
            ? null
            : String(row.column_default ?? row.COLUMN_DEFAULT),
        extra: String(row.extra ?? row.EXTRA ?? ""),
        collationName:
          (row.collation_name ?? row.COLLATION_NAME ?? null) === null
            ? null
            : String(row.collation_name ?? row.COLLATION_NAME),
        generationExpression:
          (row.generation_expression ?? row.GENERATION_EXPRESSION ?? null) === null
            ? null
            : String(row.generation_expression ?? row.GENERATION_EXPRESSION)
      });
      await this.execute(
        `alter table ${resolved} modify column \`${name}\` ${def} comment '${escapeMysqlString(
          column.description
        )}'`,
        { includeQueryInError: true }
      );
    }
  }

  public async close(): Promise<void> {
    await this.queryExecutor.close();
  }
}
