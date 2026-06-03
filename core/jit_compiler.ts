import * as $protobuf from "protobufjs";

import { JitAssertionResult } from "sa/core/actions/assertion";
import { JitOperationResult } from "sa/core/actions/operation";
import { JitTableResult } from "sa/core/actions/table";
import { IActionContext, ITableContext, JitContext } from "sa/core/contextables";
import { IncrementalTableJitContext, SqlActionJitContext, TableJitContext } from "sa/core/jit_context";
import { sqlanvil } from "sa/protos/ts";

function makeMainBody<Context, T>(code: string): (jctx: JitContext<Context>) => Promise<T> {
  return (
    jctx => {
      // tslint:disable-next-line: tsr-detect-eval-with-expression
      const body = new Function(
        "jctx", `const mainAsync = ${code};\nreturn mainAsync(jctx);`
      ) as (jctx: JitContext<Context>) => Promise<T>;
      return body(jctx);
    });
}

function makeJitTableResult(result: JitTableResult): sqlanvil.IJitTableResult {
  let jitResult: sqlanvil.IJitTableResult = {};
  if (typeof result === "string") {
    jitResult.query = result;
  } else {
    jitResult = result;
  }

  return sqlanvil.JitTableResult.create(jitResult);
}

function jitCompileOperation(
  request: sqlanvil.IJitCompilationRequest,
  adapter: sqlanvil.DbAdapter,
): Promise<sqlanvil.IJitOperationResult> {
  const mainBody = makeMainBody<IActionContext, JitOperationResult>(request.jitCode);

  const jctx: JitContext<IActionContext> = new SqlActionJitContext(
    adapter, request,
  );
  return mainBody(jctx).then(mainResult => {
    let queries: string[] | null = [];
    if (typeof mainResult === "string") {
      queries.push(mainResult);
    } else if (Array.isArray(mainResult)) {
      queries.push(...mainResult);
    } else {
      queries = mainResult.queries;
    }

    return sqlanvil.JitOperationResult.create({ queries });
  });
}

function jitCompileTable(
  request: sqlanvil.IJitCompilationRequest,
  adapter: sqlanvil.DbAdapter,
): Promise<sqlanvil.IJitTableResult> {
  const mainBody = makeMainBody<ITableContext, JitTableResult>(request.jitCode);

  const jctx: JitContext<ITableContext> = new TableJitContext(
    adapter, request,
  );
  return mainBody(jctx).then(makeJitTableResult);
}

function jitCompileAssertion(
  request: sqlanvil.IJitCompilationRequest,
  adapter: sqlanvil.DbAdapter,
): Promise<sqlanvil.IJitAssertionResult> {
  const mainBody = makeMainBody<IActionContext, JitAssertionResult>(request.jitCode);

  const jctx: JitContext<IActionContext> = new SqlActionJitContext(
    adapter, request,
  );
  return mainBody(jctx).then(query => sqlanvil.JitAssertionResult.create({ query }));
}

function jitCompileIncrementalTable(
  request: sqlanvil.IJitCompilationRequest,
  adapter: sqlanvil.DbAdapter,
): Promise<sqlanvil.IJitIncrementalTableResult> {
  const mainBody = makeMainBody<ITableContext, JitTableResult>(request.jitCode);

  const incrementalJctx = new IncrementalTableJitContext(
    adapter, request, true,
  );
  const regularJctx = new IncrementalTableJitContext(
    adapter, request, false,
  );

  return Promise.all([
    mainBody(incrementalJctx),
    mainBody(regularJctx),
  ]).then(([incrementalResult, regularResult]) => {
    return sqlanvil.JitIncrementalTableResult.create({
      incremental: makeJitTableResult(incrementalResult),
      regular: makeJitTableResult(regularResult),
    });
  });
}

export interface IJitCompiler {
  compile: (request: Uint8Array) => Promise<Uint8Array>;
}

/** RPC callback, implementing DbAdapter. */
export type RpcCallback = (method: string, request: Uint8Array, callback: (error: Error | null, response: Uint8Array) => void) => void;

export function jitCompile(request: sqlanvil.IJitCompilationRequest, rpcCallback: RpcCallback): Promise<sqlanvil.IJitCompilationResponse> {
  const rpcImpl: $protobuf.RPCImpl = (method, internalRequest, callback) => {
    rpcCallback(method.name, internalRequest, callback);
  };
  const dbAdapter = sqlanvil.DbAdapter.create(rpcImpl);

  switch (request.compilationTargetType) {
    case sqlanvil.JitCompilationTargetType.JIT_COMPILATION_TARGET_TYPE_OPERATION:
      return jitCompileOperation(request, dbAdapter).then(
        operation => sqlanvil.JitCompilationResponse.create({ operation }));
    case sqlanvil.JitCompilationTargetType.JIT_COMPILATION_TARGET_TYPE_TABLE:
      return jitCompileTable(request, dbAdapter).then(
        table => sqlanvil.JitCompilationResponse.create({ table }));
    case sqlanvil.JitCompilationTargetType.JIT_COMPILATION_TARGET_TYPE_INCREMENTAL_TABLE:
      return jitCompileIncrementalTable(request, dbAdapter).then(
        incrementalTable => sqlanvil.JitCompilationResponse.create({ incrementalTable }));
    case sqlanvil.JitCompilationTargetType.JIT_COMPILATION_TARGET_TYPE_ASSERTION:
      return jitCompileAssertion(request, dbAdapter).then(
        assertion => sqlanvil.JitCompilationResponse.create({ assertion }));
    default:
      throw new Error(`Unrecognized compilation target type: ${request.compilationTargetType}`);
  }
}

/** Main entry point for the JiT compiler. */
export function jitCompiler(rpcCallback: RpcCallback): IJitCompiler {
  return {
    compile: (request: Uint8Array) => {
      const requestMessage = sqlanvil.JitCompilationRequest.decode(request);
      return jitCompile(requestMessage, rpcCallback).then(
        response => sqlanvil.JitCompilationResponse.encode(response).finish()
      );
    }
  };
}
