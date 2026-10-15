// Entry point of the compilation worker process forked by BaseWorker
// (cli/api/commands/base_worker.ts). It serves both static and JiT compilation:
// - production: the entry point of worker_bundle.js (packages/@sqlanvil/cli/BUILD);
// - dev and tests: loaded by worker_loader.js.
// Importing this module registers the message handlers, so import it exactly once per process.
import { listenForCompileRequest } from "sa/cli/vm/compile";
import { registerJitCompileHandler } from "sa/cli/vm/jit_worker";

registerJitCompileHandler();
listenForCompileRequest();

if (process.send) {
  process.send({ type: "worker_booted" });
}
