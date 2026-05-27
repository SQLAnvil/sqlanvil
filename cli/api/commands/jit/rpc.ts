import Long from "long";

import { IDbAdapter, IDbClient } from "sa/cli/api/dbadapters";
import { IBigQueryExecutionOptions } from "sa/cli/api/dbadapters/bigquery";
import { Structs } from "sa/common/protos/structs";
import { sqlanvil, google } from "sa/protos/ts";

export async function handleDbRequest(
  dbadapter: IDbAdapter,
  dbclient: IDbClient,
  method: string,
  request: Uint8Array,
  options?: IBigQueryExecutionOptions
): Promise<Uint8Array> {
  switch (method) {
    case "Execute":
      return await handleExecute(dbclient, request, options);
    case "ListTables":
      return await handleListTables(dbadapter, request);
    case "GetTable":
      return await handleGetTable(dbadapter, request);
    case "DeleteTable":
      return await handleDeleteTable(dbadapter, request, options?.dryRun);
    default:
      throw new Error(`Unrecognized RPC method: ${method}`);
  }
}

async function handleExecute(
  dbclient: IDbClient,
  request: Uint8Array,
  options?: IBigQueryExecutionOptions
): Promise<Uint8Array> {
  const executeRequest = sqlanvil.ExecuteRequest.decode(request);
  const executeRequestObj = sqlanvil.ExecuteRequest.toObject(executeRequest, {
    defaults: false
  });
  const requestOptions = executeRequestObj.bigQueryOptions;

  const results = await dbclient.executeRaw(executeRequest.statement, {
    rowLimit: executeRequest.rowLimit ? (executeRequest.rowLimit as Long).toNumber() : undefined,
    params: Structs.toObject(executeRequest.params),
    bigquery: {
      ...options,
      ...requestOptions,
      labels: {
        ...options?.labels,
        ...requestOptions?.labels
      },
      jobPrefix: [options?.jobPrefix, requestOptions?.jobPrefix].filter(Boolean).join("-") || undefined
    }
  });

  return sqlanvil.ExecuteResponse.encode({
    rows: (results.rows || []).map(row => Structs.fromObject(row)),
    schemaFields: results.schema || []
  } as any).finish();
}

async function handleListTables(dbadapter: IDbAdapter, request: Uint8Array): Promise<Uint8Array> {
  const listTablesRequest = sqlanvil.ListTablesRequest.decode(request);
  if (!listTablesRequest.database) {
    throw new Error("ListTablesRequest.database must be supplied");
  }
  const tablesMetadata = await dbadapter.tables(listTablesRequest.database, listTablesRequest.schema);
  const listTablesResponse = sqlanvil.ListTablesResponse.create({
    tables: tablesMetadata
  });
  return sqlanvil.ListTablesResponse.encode(listTablesResponse).finish();
}

async function handleGetTable(dbadapter: IDbAdapter, request: Uint8Array): Promise<Uint8Array> {
  const getTableRequest = sqlanvil.GetTableRequest.decode(request);
  const tableMetadata = await dbadapter.table(getTableRequest.target);
  if (!tableMetadata) {
    throw new Error(`Table not found: ${JSON.stringify(getTableRequest.target)}`);
  }
  return sqlanvil.TableMetadata.encode(tableMetadata).finish();
}

async function handleDeleteTable(
  dbadapter: IDbAdapter,
  request: Uint8Array,
  dryRun?: boolean
): Promise<Uint8Array> {
  const deleteTableRequest = sqlanvil.DeleteTableRequest.decode(request);
  if (dryRun) {
    return new Uint8Array();
  }
  await dbadapter.deleteTable(deleteTableRequest.target);
  return new Uint8Array();
}
