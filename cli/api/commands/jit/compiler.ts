import { ChildProcess } from "child_process";
import * as path from "path";

import { BaseWorker } from "sa/cli/api/commands/base_worker";
import { handleDbRequest } from "sa/cli/api/commands/jit/rpc";
import { IDbAdapter, IDbClient } from "sa/cli/api/dbadapters";
import { IBigQueryExecutionOptions } from "sa/cli/api/dbadapters/bigquery";
import { DEFAULT_COMPILATION_TIMEOUT_MILLIS } from "sa/cli/api/utils/constants";
import { sqlanvil } from "sa/protos/ts";

export interface IJitWorkerMessage {
  type: "rpc_request" | "jit_response" | "jit_error";
  method?: string;
  request?: Uint8Array;
  correlationId?: string;
  response?: Uint8Array;
  error?: string;
}

export class JitCompileChildProcess extends BaseWorker<
  sqlanvil.IJitCompilationResponse,
  IJitWorkerMessage
> {
  public static async compile(
    request: sqlanvil.IJitCompilationRequest,
    projectDir: string,
    dbadapter: IDbAdapter,
    dbclient: IDbClient,
    timeoutMillis: number = DEFAULT_COMPILATION_TIMEOUT_MILLIS,
    options?: IBigQueryExecutionOptions
  ): Promise<sqlanvil.IJitCompilationResponse> {
    return await new JitCompileChildProcess().run(
      request,
      projectDir,
      dbadapter,
      dbclient,
      timeoutMillis,
      options
    );
  }

  constructor() {
    super(path.resolve(__dirname, "../../../vm/jit_loader"));
  }

  private async run(
    request: sqlanvil.IJitCompilationRequest,
    projectDir: string,
    dbadapter: IDbAdapter,
    dbclient: IDbClient,
    timeoutMillis: number,
    options?: IBigQueryExecutionOptions
  ): Promise<sqlanvil.IJitCompilationResponse> {
    return await this.runWorker(
      timeoutMillis,
      child => {
        child.send({
          type: "jit_compile",
          request,
          projectDir
        });
      },
      async (message, child, resolve, reject) => {
        if (message.type === "rpc_request") {
          await this.handleRpcRequest(message, child, dbadapter, dbclient, options);
        } else if (message.type === "jit_response") {
          resolve(sqlanvil.JitCompilationResponse.fromObject(message.response));
        } else if (message.type === "jit_error") {
          reject(new Error(message.error));
        }
      }
    );
  }

  private async handleRpcRequest(
    message: IJitWorkerMessage,
    child: ChildProcess,
    dbadapter: IDbAdapter,
    dbclient: IDbClient,
    options?: IBigQueryExecutionOptions
  ) {
    try {
      const response = await handleDbRequest(
        dbadapter,
        dbclient,
        message.method,
        message.request,
        options
      );
      child.send({
        type: "rpc_response",
        correlationId: message.correlationId,
        response
      });
    } catch (e) {
      child.send({
        type: "rpc_response",
        correlationId: message.correlationId,
        error: e.message
      });
    }
  }
}
