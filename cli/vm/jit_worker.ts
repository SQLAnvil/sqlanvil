import * as fs from "fs";
import * as path from "path";

import { VmRunner } from "sa/common/vm/vm_runner";
import { sqlanvil } from "sa/protos/ts";

const pendingRpcCallbacks = new Map<
  string,
  (err: string | null, resBytes: Uint8Array | null) => void
>();
let hasStartedProcessing = false;

process.on("message", (res: any) => {
  if (res.type === "rpc_response") {
    const callback = pendingRpcCallbacks.get(res.correlationId);
    if (callback) {
      pendingRpcCallbacks.delete(res.correlationId);
      if (res.error) {
        callback(res.error, null);
      } else {
        callback(null, res.response);
      }
    }
  }
});

export async function handleJitRequest(message: { request: any; projectDir: string }) {
  try {
    const { request, projectDir } = message;

    if (!fs.existsSync(path.join(projectDir, "node_modules", "@sqlanvil", "core", "bundle.js"))) {
      throw new Error(
        "Could not find a recent installed version of @sqlanvil/core in the project. Check that " +
          "either `sqlanvilCoreVersion` is specified in `workflow_settings.yaml`, or " +
          "`@sqlanvil/core` is specified in `package.json`. If using `package.json`, then run " +
          "`sqlanvil install`.",
      );
    }

    const rpcCallback = (
      method: string,
      reqBytes: Uint8Array,
      callback: (err: string | null, resBytes: Uint8Array | null) => void,
    ) => {
      const correlationId = Math.random().toString(36).substring(7);
      pendingRpcCallbacks.set(correlationId, callback);

      process.send({
        type: "rpc_request",
        method,
        request: reqBytes,
        correlationId,
      });
    };

    const requestMessage = sqlanvil.JitCompilationRequest.fromObject(request);
    const requestBytes = sqlanvil.JitCompilationRequest.encode(requestMessage).finish();

    const vmFileName = path.resolve(projectDir, "index.js");

    // No builtins, only @sqlanvil/* packages, and (unlike the vm2 version) no host
    // environment: VmRunner's process.env defaults to empty.
    const vm = new VmRunner({
      projectDir,
      builtinModules: [],
      allowedModules: ["@sqlanvil/*"],
      sourceExtensions: ["js", "json", "yaml", "yml"],
    });

    const jitCompileInVm = vm.run(
      `
      const { jitCompiler } = require("@sqlanvil/core");

      global.require = require;

      module.exports = async (requestBytes, armoredRpcCallback) => {
        const internalRpcCallback = (method, reqBytes, callback) => {
           armoredRpcCallback(method, reqBytes, (errStr, resBytes) => {
              if (errStr) {
                callback(new Error(errStr), null);
              } else {
                callback(null, resBytes);
              }
           });
        };

        const compilerInstance = jitCompiler(internalRpcCallback);
        return await compilerInstance.compile(requestBytes);
      };
    `,
      vmFileName,
    );

    const responseBytes = await jitCompileInVm(requestBytes, rpcCallback);
    const response = sqlanvil.JitCompilationResponse.decode(responseBytes);

    process.send({ type: "jit_response", response: response.toJSON() });
  } catch (e) {
    process.send({ type: "jit_error", error: e.stack || e.message });
  }
}

export function registerJitCompileHandler() {
  process.on("message", async (message: any) => {
    if (message.request) {
      if (hasStartedProcessing) {
        process.send({
          type: "jit_error",
          error:
            "Worker process received multiple JiT compilation requests. Subsequent requests are rejected.",
        });
        return;
      }
      hasStartedProcessing = true;
      await handleJitRequest(message);
    }
  });
}
