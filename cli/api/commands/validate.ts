import {
  dependencyBlocked,
  OrderedNode,
  shadowSchemasToSweep,
  targetKey,
  topoOrder,
  ValidationResult,
  ValidationStatus
} from "sa/cli/api/commands/validate_graph";
import { sqlanvil } from "sa/protos/ts";

/** Orphaned shadow schemas/databases older than this are swept before a validate run. */
export const SHADOW_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * `sqlanvil validate` orchestrator: walk a compiled graph in dependency order and validate each
 * model against the warehouse planner (EXPLAIN / dry-run) without executing, materializing an
 * empty, isolated shadow-schema stub after each pass so downstream refs resolve. Every shadow
 * schema is dropped in a `finally`. Pure-ish: all warehouse I/O goes through `ValidateDeps`, so
 * this is unit-testable with a fake adapter.
 */

export interface ValidateDeps {
  /** Adapter `evaluate()` — EXPLAINs/dry-runs the action, returning located results. */
  evaluate(action: sqlanvil.ITable | sqlanvil.IAssertion): Promise<sqlanvil.IQueryEvaluation[]>;
  /** Adapter `execute()` — runs a DDL statement (schema create/drop, stub create). */
  execute(sql: string): Promise<void>;
  validationStubSql(table: sqlanvil.ITable): string;
  createSchemaSql(schema: string): string;
  dropSchemaCascadeSql(schema: string): string;
  /** All schema (database, on MySQL) names — used to find orphaned validation shadows. */
  listSchemas(): Promise<string[]>;
}

/**
 * Drop validation shadow schemas/databases left behind by killed runs (older than `maxAgeMs`).
 * Best-effort housekeeping run before a validate; never throws — a sweep failure must not block
 * the actual validation. The current run's own fresh shadow is too new to match.
 */
export async function sweepOrphanShadows(
  deps: ValidateDeps,
  nowMs: number,
  maxAgeMs: number = SHADOW_MAX_AGE_MS
): Promise<void> {
  try {
    const schemas = await deps.listSchemas();
    for (const schema of shadowSchemasToSweep(schemas, nowMs, maxAgeMs)) {
      try {
        await deps.execute(deps.dropSchemaCascadeSql(schema));
      } catch (e) {
        // ignore — another run may be dropping it concurrently
      }
    }
  } catch (e) {
    // ignore — listing schemas failed; housekeeping is best-effort
  }
}

export interface ValidateOptions {
  keepShadow?: boolean;
}

type NodeKind = "table" | "assertion" | "operation";

interface ValidateNode extends OrderedNode {
  kind: NodeKind;
  type: string; // table | view | incremental | assertion | operation
  target: sqlanvil.ITarget;
  table?: sqlanvil.ITable; // set for kind === "table" (used for the stub)
  action: sqlanvil.ITable | sqlanvil.IAssertion;
}

function tableType(enumType: sqlanvil.TableType): string {
  switch (enumType) {
    case sqlanvil.TableType.VIEW:
      return "view";
    case sqlanvil.TableType.INCREMENTAL:
      return "incremental";
    default:
      return "table";
  }
}

function depKeys(deps?: sqlanvil.ITarget[]): string[] {
  return (deps || []).map(targetKey);
}

export async function validate(
  compiledGraph: sqlanvil.ICompiledGraph,
  deps: ValidateDeps,
  options: ValidateOptions = {}
): Promise<ValidationResult[]> {
  const nodes: ValidateNode[] = [];

  for (const table of compiledGraph.tables || []) {
    nodes.push({
      key: targetKey(table.target),
      dependencyKeys: depKeys(table.dependencyTargets),
      kind: "table",
      type: tableType(table.enumType),
      target: table.target,
      table,
      action: table
    });
  }
  for (const assertion of compiledGraph.assertions || []) {
    nodes.push({
      key: targetKey(assertion.target),
      dependencyKeys: depKeys(assertion.dependencyTargets),
      kind: "assertion",
      type: "assertion",
      target: assertion.target,
      action: assertion
    });
  }
  // Operations are not validated (arbitrary, side-effecting SQL) but are kept as SKIPPED nodes so
  // a model that depends on an operation's output is correctly reported BLOCKED rather than FAILURE.
  for (const operation of compiledGraph.operations || []) {
    if (!operation.target) {
      continue;
    }
    nodes.push({
      key: targetKey(operation.target),
      dependencyKeys: depKeys(operation.dependencyTargets),
      kind: "operation",
      type: "operation",
      target: operation.target,
      action: undefined
    });
  }

  const ordered = topoOrder(nodes);
  // Only table/view/incremental stubs get materialized, so only their schemas need creating.
  const shadowSchemas = Array.from(
    new Set(nodes.filter(n => n.kind === "table").map(n => n.target.schema))
  );

  const statusByKey = new Map<string, ValidationStatus>();
  const results: ValidationResult[] = [];

  try {
    for (const schema of shadowSchemas) {
      await deps.execute(deps.createSchemaSql(schema));
    }

    for (const node of ordered) {
      if (node.kind === "operation") {
        statusByKey.set(node.key, "SKIPPED");
        results.push({ target: node.target, type: node.type, status: "SKIPPED", errors: [] });
        continue;
      }
      if (dependencyBlocked(node.dependencyKeys, statusByKey)) {
        statusByKey.set(node.key, "BLOCKED");
        results.push({ target: node.target, type: node.type, status: "BLOCKED", errors: [] });
        continue;
      }

      const evaluations = await deps.evaluate(node.action);
      const failed = evaluations.some(
        e => e.status === sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE
      );
      const status: ValidationStatus = failed ? "FAILURE" : "PASS";
      statusByKey.set(node.key, status);
      results.push({ target: node.target, type: node.type, status, errors: evaluations });

      // Materialize an empty stub so later models resolve their ${ref()} to this relation.
      if (status === "PASS" && node.kind === "table") {
        try {
          await deps.execute(deps.validationStubSql(node.table));
        } catch (e) {
          // Best-effort: the model's own SQL validated; if the empty-stub create fails (e.g. an
          // exotic query shape), downstream dependents simply surface their own missing-ref error.
        }
      }
    }
  } finally {
    if (!options.keepShadow) {
      for (const schema of shadowSchemas.slice().reverse()) {
        try {
          await deps.execute(deps.dropSchemaCascadeSql(schema));
        } catch (e) {
          // Best-effort teardown; never mask the underlying validation outcome.
        }
      }
    }
  }

  return results;
}
