import * as pg from "pg";

import { collectEvaluationQueries, QueryOrAction } from "sa/cli/api/dbadapters/execution_sql";
import {
  IDbAdapter,
  IDbClient,
  IExecutionResult,
  IExecutionResultRaw,
  OnCancel
} from "sa/cli/api/dbadapters/index";
import { parsePostgresEvalError } from "sa/cli/api/utils/error_parsing";
import { convertFieldType, PgPoolExecutor } from "sa/cli/api/utils/postgres";
import { ErrorWithCause } from "sa/common/errors/errors";
import { sqlanvil } from "sa/protos/ts";

const INTERNAL_SCHEMAS = new Set(["information_schema", "pg_catalog", "pg_internal", "pg_toast"]);

export class PostgresDbAdapter implements IDbAdapter {
  public static async create(
    credentials: sqlanvil.IPostgresConnection,
    options?: { concurrencyLimit?: number; disableSslForTestsOnly?: boolean }
  ): Promise<PostgresDbAdapter> {
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
            // Supabase and most managed Postgres providers serve certs signed
            // by their own CA. Skipping verification is the documented path
            // for `sslmode=require`. Stricter `verify-ca` / `verify-full`
            // requires a CA bundle that we don't ship today.
            rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full"
          }
        : false
    };
    const queryExecutor = new PgPoolExecutor(clientConfig, options);
    return new PostgresDbAdapter(queryExecutor);
  }

  protected constructor(protected readonly queryExecutor: PgPoolExecutor) {}

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
            const rows = await client.execute(stmt, opts);
            return { rows, metadata: {} };
          } catch (e) {
            if (opts.includeQueryInError) {
              throw new Error(`Error encountered while running "${stmt}": ${e.message}`);
            }
            throw new ErrorWithCause(`Error executing postgres query: ${e.message}`, e);
          }
        },
        executeRaw: async (
          stmt: string,
          opts: { params?: { [name: string]: any }; rowLimit?: number } = { rowLimit: 1000 }
        ): Promise<IExecutionResultRaw> => {
          // Convert named param object to positional array — pg uses $1, $2 etc.
          const positional = opts.params ? Object.values(opts.params) : undefined;
          const rows = await client.execute(stmt, { params: positional, rowLimit: opts.rowLimit });
          return { rows, schema: [], metadata: {} };
        }
      })
    );
  }

  public async evaluate(queryOrAction: QueryOrAction): Promise<sqlanvil.IQueryEvaluation[]> {
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
          error: parsePostgresEvalError(validationQuery.query, e)
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

  public async tables(
    _database: string,
    schema?: string
  ): Promise<sqlanvil.ITableMetadata[]> {
    const params: any[] = [];
    let schemaClause = "";
    let matviewSchemaClause = "";
    if (schema) {
      schemaClause = "and table_schema = $1";
      matviewSchemaClause = "and schemaname = $1";
      params.push(schema);
    }
    // information_schema.tables excludes materialized views, so union them in
    // from pg_matviews — otherwise existing matviews are invisible to the run
    // pipeline (and would be needlessly recreated instead of refreshed).
    const queryResult = await this.execute(
      `select table_name, table_schema
       from information_schema.tables
       where table_schema not in ('information_schema', 'pg_catalog', 'pg_internal', 'pg_toast')
       ${schemaClause}
       union
       select matviewname as table_name, schemaname as table_schema
       from pg_matviews
       where schemaname not in ('information_schema', 'pg_catalog', 'pg_internal', 'pg_toast')
       ${matviewSchemaClause}`,
      { params, rowLimit: 10000, includeQueryInError: true }
    );
    const targets = queryResult.rows.map(row => ({
      schema: row.table_schema as string,
      name: row.table_name as string
    }));
    // Hydrate full metadata for each target — IDbAdapter.tables returns
    // ITableMetadata[], not ITarget[].
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
       where tables.table_schema ilike $1
          or tables.table_name ilike $1
          or columns.column_name ilike $1
       group by 1, 2`,
      {
        params: [`%${searchText}%`],
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
    // information_schema excludes materialized views, so detect them separately
    // via pg_matviews (existence) + pg_attribute (columns).
    const [tableResults, columnResults, descriptionResults, matviewResults, matviewColumns] =
      await Promise.all([
        this.execute(
          `select table_type from information_schema.tables where table_schema = $1 and table_name = $2`,
          { params, includeQueryInError: true }
        ),
        this.execute(
          `select column_name, data_type, is_nullable, ordinal_position
           from information_schema.columns
           where table_schema = $1 and table_name = $2`,
          { params, includeQueryInError: true }
        ),
        this.execute(
          `select objsubid as column_number, description
           from pg_description
           where objoid = (
             select oid from pg_class where relname = $2 and relnamespace = (
               select oid from pg_namespace where nspname = $1
             )
           )`,
          { params, includeQueryInError: true }
        ),
        this.execute(
          `select 1 from pg_matviews where schemaname = $1 and matviewname = $2`,
          { params, includeQueryInError: true }
        ),
        this.execute(
          `select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type,
                  a.attnum as ordinal_position
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
           order by a.attnum`,
          { params, includeQueryInError: true }
        )
      ]);

    const findDescription = (columnNumber: number) =>
      descriptionResults.rows.find(row => row.column_number === columnNumber)?.description;

    if (tableResults.rows.length > 0) {
      return sqlanvil.TableMetadata.create({
        target,
        type:
          tableResults.rows[0].table_type === "VIEW"
            ? sqlanvil.TableMetadata.Type.VIEW
            : sqlanvil.TableMetadata.Type.TABLE,
        fields: columnResults.rows.map(row =>
          sqlanvil.Field.create({
            name: row.column_name,
            primitive: convertFieldType(row.data_type),
            description: findDescription(row.ordinal_position)
          })
        ),
        description: findDescription(0)
      });
    }

    if (matviewResults.rows.length > 0) {
      return sqlanvil.TableMetadata.create({
        target,
        type: sqlanvil.TableMetadata.Type.MATERIALIZED_VIEW,
        fields: matviewColumns.rows.map(row =>
          sqlanvil.Field.create({
            name: row.column_name,
            // format_type includes length/precision modifiers (e.g.
            // "character varying(255)"); strip them for convertFieldType.
            primitive: convertFieldType(String(row.data_type).replace(/\(.*\)/, "")),
            description: findDescription(row.ordinal_position)
          })
        ),
        description: findDescription(0)
      });
    }

    return null;
  }

  public async deleteTable(target: sqlanvil.ITarget): Promise<void> {
    const metadata = await this.table(target);
    if (!metadata) {
      return;
    }
    const kind = metadata.type === sqlanvil.TableMetadata.Type.VIEW ? "view" : "table";
    await this.execute(
      `drop ${kind} if exists "${target.schema}"."${target.name}" cascade`,
      { includeQueryInError: true }
    );
  }

  public async schemas(_database: string): Promise<string[]> {
    const result = await this.execute(`select nspname from pg_namespace`, {
      includeQueryInError: true
    });
    return result.rows
      .map(row => row.nspname as string)
      .filter(name => !INTERNAL_SCHEMAS.has(name) && !name.startsWith("pg_"));
  }

  public async createSchema(_database: string, schema: string): Promise<void> {
    await this.execute(`create schema if not exists "${schema}"`, {
      includeQueryInError: true
    });
  }

  public async setMetadata(action: sqlanvil.IExecutionAction): Promise<void> {
    const { target, actionDescriptor, tableType } = action;
    const actualMetadata = await this.table(target);
    if (!actualMetadata) {
      return;
    }

    // Materialized views need COMMENT ON MATERIALIZED VIEW (a matview action
    // still carries tableType "view"); detect via the resolved metadata type.
    const relationKind =
      actualMetadata.type === sqlanvil.TableMetadata.Type.MATERIALIZED_VIEW
        ? "materialized view"
        : tableType === "view"
        ? "view"
        : "table";

    const queries: Array<Promise<unknown>> = [];
    if (actionDescriptor?.description) {
      queries.push(
        this.execute(
          `comment on ${relationKind} "${target.schema}"."${
            target.name
          }" is '${actionDescriptor.description.replace(/'/g, "''")}'`
        )
      );
    }
    if (actionDescriptor?.columns?.length > 0) {
      actionDescriptor.columns
        .filter(
          column =>
            column.path.length === 1 &&
            actualMetadata.fields.some(field => field.name === column.path[0])
        )
        .forEach(column => {
          queries.push(
            this.execute(
              `comment on column "${target.schema}"."${target.name}"."${
                column.path[0]
              }" is '${column.description.replace(/'/g, "''")}'`
            )
          );
        });
    }
    await Promise.all(queries);
  }

  public async close(): Promise<void> {
    await this.queryExecutor.close();
  }
}
