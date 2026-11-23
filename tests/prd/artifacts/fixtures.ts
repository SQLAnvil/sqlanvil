// Graphs and run results of docs/prd/sqlanvil/test-cases/artifacts.yaml (&G1 in T-001.1, &R1 in
// T-005.1). Each call returns a fresh object, so a case never sees another case's mutations.
import { sqlanvil } from "sa/protos/ts";

export function g1(): any {
  return {
    tables: [
      {
        target: { schema: "s", name: "src" },
        enumType: sqlanvil.TableType.TABLE,
        tags: ["daily"],
        fileName: "definitions/src.sqlx",
        actionDescriptor: { description: "source", columns: [{ path: ["id"], description: "the id" }] },
      },
      {
        target: { schema: "s", name: "v" },
        enumType: sqlanvil.TableType.VIEW,
        dependencyTargets: [{ schema: "s", name: "src" }],
      },
    ],
    assertions: [{ target: { schema: "s", name: "a" }, dependencyTargets: [{ schema: "s", name: "v" }] }],
    operations: [],
    exports: [],
    declarations: [],
  };
}

export function r1(): any {
  return {
    status: sqlanvil.RunResult.ExecutionStatus.FAILED,
    actions: [
      {
        target: { schema: "s", name: "src" },
        status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
        timing: { startTimeMillis: 1000, endTimeMillis: 1400 },
        tasks: [],
      },
      {
        target: { schema: "s", name: "v" },
        status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
        timing: { startTimeMillis: 1400, endTimeMillis: 1600 },
        tasks: [{ errorMessage: "boom" }],
      },
    ],
  };
}

export function emptyGraph(): any {
  return { tables: [], operations: [], assertions: [], exports: [], declarations: [] };
}

export function successfulEmptyRun(): any {
  return { status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL, actions: [] };
}

// The run result of T-018.5 and T-019.3: src succeeded, v skipped with no timing.
export function runWithSkipped(): any {
  return {
    status: sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
    actions: [
      {
        target: { schema: "s", name: "src" },
        status: sqlanvil.ActionResult.ExecutionStatus.SUCCESSFUL,
        timing: { startTimeMillis: 1000, endTimeMillis: 1400 },
        tasks: [],
      },
      {
        target: { schema: "s", name: "v" },
        status: sqlanvil.ActionResult.ExecutionStatus.SKIPPED,
        tasks: [],
      },
    ],
  };
}
