import { sqlanvil } from "sa/protos/ts";

/**
 * Pure ordering + classification logic for `sqlanvil validate` (no I/O, no warehouse).
 * Kept separate from the orchestrator so it is unit-testable without an adapter.
 */

export type ValidationStatus = "PASS" | "FAILURE" | "BLOCKED" | "SKIPPED";

export interface ValidationResult {
  target: sqlanvil.ITarget;
  // "table" | "view" | "incremental" | "assertion" | "operation" | "export"
  type: string;
  status: ValidationStatus;
  // QueryEvaluation entries for this action (the located errors on FAILURE).
  errors: sqlanvil.IQueryEvaluation[];
}

/** Canonical key for a target — matches across an action's own target and dependencyTargets. */
export function targetKey(target: sqlanvil.ITarget): string {
  return [target.database, target.schema, target.name].filter(Boolean).join(".");
}

export interface OrderedNode {
  key: string;
  /** Keys this node depends on. Keys not present in the node set are ignored (sources). */
  dependencyKeys: string[];
}

/**
 * Topological sort (Kahn's algorithm) over the given nodes. Dependencies that aren't part of
 * the node set (declarations / external sources) are ignored. Deterministic: ready nodes are
 * emitted in ascending key order. On a cycle, the remaining nodes are appended by key so the
 * caller still gets every node (the compiler rejects real cycles upstream anyway).
 */
export function topoOrder<T extends OrderedNode>(nodes: T[]): T[] {
  const byKey = new Map<string, T>(nodes.map(n => [n.key, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep key -> nodes that depend on it

  for (const n of nodes) {
    const inGraphDeps = Array.from(
      new Set(n.dependencyKeys.filter(d => byKey.has(d) && d !== n.key))
    );
    indegree.set(n.key, inGraphDeps.length);
    for (const dep of inGraphDeps) {
      dependents.set(dep, (dependents.get(dep) || []).concat(n.key));
    }
  }

  const ready = nodes
    .filter(n => (indegree.get(n.key) || 0) === 0)
    .map(n => n.key)
    .sort();
  const ordered: T[] = [];
  const emitted = new Set<string>();

  while (ready.length) {
    const key = ready.shift();
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    ordered.push(byKey.get(key));
    for (const dep of (dependents.get(key) || []).slice().sort()) {
      indegree.set(dep, (indegree.get(dep) || 0) - 1);
      if ((indegree.get(dep) || 0) <= 0 && !emitted.has(dep)) {
        ready.push(dep);
        ready.sort();
      }
    }
  }

  // Cycle fallback: append anything left, by key, so no node is silently dropped.
  if (ordered.length < nodes.length) {
    for (const n of nodes.slice().sort((a, b) => a.key.localeCompare(b.key))) {
      if (!emitted.has(n.key)) {
        emitted.add(n.key);
        ordered.push(n);
      }
    }
  }
  return ordered;
}

/**
 * A node is BLOCKED if any of its in-graph dependencies did not PASS — i.e. an upstream model
 * FAILED, was itself BLOCKED, or was SKIPPED (e.g. an unvalidated operation whose output this
 * model references). Such a node's own SQL can't be meaningfully validated, so we don't run it.
 */
export function dependencyBlocked(
  dependencyKeys: string[],
  statusByKey: Map<string, ValidationStatus>
): boolean {
  return dependencyKeys.some(dep => {
    const status = statusByKey.get(dep);
    return status !== undefined && status !== "PASS";
  });
}

// --- Shadow-namespace naming + orphan detection (sqlanvil validate). ---

/** Marker embedded in every validation shadow schema/database name, followed by a timestamp. */
export const VALIDATE_SHADOW_PREFIX = "sqlanvil_validate_";

/** The schemaSuffix fragment for a validation run started at `nowMs` (epoch millis). */
export function validateShadowSuffix(nowMs: number): string {
  return `${VALIDATE_SHADOW_PREFIX}${nowMs}`;
}

/** Extract the run timestamp from a shadow schema/database name, or null if it isn't one. */
export function parseShadowTimestamp(schemaName: string): number | null {
  const match = schemaName.match(/sqlanvil_validate_(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * From a list of schema/database names, pick the validation shadows older than `maxAgeMs` —
 * orphans left by killed runs. Names without the marker (real schemas) are never returned, and
 * an in-flight run's own fresh shadow (age < maxAgeMs) is left alone.
 */
export function shadowSchemasToSweep(
  schemaNames: string[],
  nowMs: number,
  maxAgeMs: number
): string[] {
  return schemaNames.filter(name => {
    const ts = parseShadowTimestamp(name);
    return ts !== null && nowMs - ts > maxAgeMs;
  });
}
