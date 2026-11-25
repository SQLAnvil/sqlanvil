import { concatenateQueries } from "sa/cli/api/utils/query_transforms";
import { sqlanvil } from "sa/protos/ts";

// From upstream #2408 (JiT parts not taken). In a BigQuery dry run, a task wrapped in a script
// that creates its missing target dataset is only syntax-checked, so the action's SELECT query is
// also dry-run on its own.

/**
 * Key of `IExecutionOptions.dryRunValidationQueries`. Unlike `targetStringifier`, it doesn't depend
 * on which (possibly empty) fields happen to be set on the target proto, so that targets of the
 * compiled graph and of the execution graph match.
 */
export function dryRunValidationQueryKey(target: sqlanvil.ITarget): string {
  return JSON.stringify([target.database || "", target.schema || "", target.name || ""]);
}

/**
 * Returns the compiled SELECT queries (including pre-operations, which may declare variables or
 * temporary objects used by the query; post-operations are excluded as they often reference the
 * not-yet-created target table) of the enabled tables, views, incremental tables and assertions
 * of the graph, keyed by `dryRunValidationQueryKey()`.
 */
export function buildDryRunValidationQueries(
  compiledGraph: sqlanvil.ICompiledGraph,
): Map<string, string> {
  const queries = new Map<string, string>();
  [...(compiledGraph.tables || []), ...(compiledGraph.assertions || [])]
    .filter((action) => !action.disabled)
    .forEach((action) => {
      const query = actionDryRunValidationQuery(action);
      if (query) {
        queries.set(dryRunValidationQueryKey(action.target), query);
      }
    });
  return queries;
}

export function actionDryRunValidationQuery(
  action?: { preOps?: string[] | null; query?: string | null } | null,
): string | undefined {
  if (!action?.query?.trim()) {
    return undefined;
  }
  return concatenateQueries(
    [...(action.preOps || []).map((preOp) => preOp.trim()), action.query],
    undefined,
    false,
  );
}
