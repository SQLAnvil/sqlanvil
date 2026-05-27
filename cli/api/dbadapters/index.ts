import { QueryOrAction } from "sa/cli/api/dbadapters/execution_sql";
import { sqlanvil } from "sa/protos/ts";

export type OnCancel = (handleCancel: () => void) => void;

export interface IExecutionResult {
  rows: any[];
  metadata: sqlanvil.IExecutionMetadata;
}

export interface IExecutionResultRaw extends IExecutionResult {
  schema?: sqlanvil.IField[];
}

export interface IBigQueryError extends Error {
  metadata?: sqlanvil.IExecutionMetadata
}

export interface IDbClient {
  execute(
    statement: string,
    options?: {
      onCancel?: OnCancel;
      interactive?: boolean;
      rowLimit?: number;
      byteLimit?: number;
      bigquery?: {
        labels?: { [label: string]: string };
        location?: string;
        jobPrefix?: string;
        dryRun?: boolean;
        reservation?: string;
      };
    }
  ): Promise<IExecutionResult>;

  executeRaw(
    statement: string,
    options?: {
      params?: { [name: string]: any };
      rowLimit?: number;
      bigquery?: {
        labels?: { [label: string]: string };
        location?: string;
        jobPrefix?: string;
        dryRun?: boolean;
        reservation?: string;
      };
    }
  ): Promise<IExecutionResultRaw>;
}

export interface IDbAdapter extends IDbClient {
  withClientLock<T>(callback: (client: IDbClient) => Promise<T>): Promise<T>;

  evaluate(queryOrAction: QueryOrAction): Promise<sqlanvil.IQueryEvaluation[]>;

  schemas(database: string): Promise<string[]>;
  createSchema(database: string, schema: string): Promise<void>;

  tables(database: string, schema?: string): Promise<sqlanvil.ITableMetadata[]>;
  search(searchText: string, options?: { limit: number }): Promise<sqlanvil.ITableMetadata[]>;
  table(target: sqlanvil.ITarget): Promise<sqlanvil.ITableMetadata>;
  deleteTable(target: sqlanvil.ITarget): Promise<void>;

  setMetadata(action: sqlanvil.IExecutionAction): Promise<void>;
}
