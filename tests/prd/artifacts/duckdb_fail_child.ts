// Child process of T-017.1: calls safeWriteArtifacts(G1, P, {warn}) and prints what happened as
// one line starting RESULT_MARKER. Run with the duckdb_block_preload preload.
import { safeWriteArtifacts } from "sa/cli/api/commands/artifacts";
import { g1 } from "sa/tests/prd/artifacts/fixtures";

const RESULT_MARKER = "__PRD_T_017_1_RESULT__";

async function main() {
  const projectDir = process.argv[2];
  const warnings: string[] = [];
  let resolved = false;
  let error: string | undefined;
  try {
    await (safeWriteArtifacts as any)(g1(), projectDir, {
      warn: (message: string) => warnings.push(message),
    });
    resolved = true;
  } catch (e) {
    const err: any = e;
    error = String((err && err.stack) || err);
  }
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ resolved, warnings, error })}\n`);
}

main().catch((e: any) => {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ resolved: false, warnings: [], error: String(e) })}\n`);
});
