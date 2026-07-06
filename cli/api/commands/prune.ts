import { targetAsReadableString } from "sa/core/targets";
import * as utils from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

type CompileAction =
  | sqlanvil.ITable
  | sqlanvil.IOperation
  | sqlanvil.IAssertion
  | sqlanvil.IExport
  | sqlanvil.IImport
  | sqlanvil.IExtract
  | sqlanvil.IScript;

export function prune(
  compiledGraph: sqlanvil.ICompiledGraph,
  runConfig: sqlanvil.IRunConfig
): sqlanvil.ICompiledGraph {
  compiledGraph.tables.forEach(utils.setOrValidateTableEnumType);
  const includedActionNames = computeIncludedActionNames(compiledGraph, runConfig);
  return {
    ...compiledGraph,
    tables: compiledGraph.tables.filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    assertions: compiledGraph.assertions.filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    operations: compiledGraph.operations.filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    exports: compiledGraph.exports.filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    imports: compiledGraph.imports.filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    // Extracts (runner-extract source materializations) prune like any other action: a
    // selective run only reads a source if a selected action depends on it (--include-deps
    // pulls it in) — it shouldn't re-extract (and bill) unrelated sources.
    extracts: (compiledGraph.extracts || []).filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    ),
    scripts: (compiledGraph.scripts || []).filter(action =>
      includedActionNames.has(targetAsReadableString(action.target))
    )
  };
}

function computeIncludedActionNames(
  compiledGraph: sqlanvil.ICompiledGraph,
  runConfig: sqlanvil.IRunConfig
): Set<string> {
  // Union all tables, operations, assertions.
  const allActions: CompileAction[] = [].concat(
    compiledGraph.tables,
    compiledGraph.operations,
    compiledGraph.assertions,
    compiledGraph.exports,
    compiledGraph.imports,
    compiledGraph.extracts || [],
    compiledGraph.scripts || []
  );

  const allActionNames = new Set<string>(
    allActions.map(action => targetAsReadableString(action.target))
  );
  const allActionsByName = new Map<string, CompileAction>(
    allActions.map(action => [targetAsReadableString(action.target), action])
  );

  const hasActionSelector = runConfig.actions?.length > 0;
  const hasTagSelector = runConfig.tags?.length > 0;

  // If no selectors, return all actions.
  if (!hasActionSelector && !hasTagSelector) {
    return allActionNames;
  }

  const includedActionNames = new Set<string>();

  // Add all actions included by action filters.
  if (hasActionSelector) {
    utils
      .matchPatterns(runConfig.actions, [...allActionNames])
      .forEach(actionName => includedActionNames.add(actionName));
  }

  // Determine actions selected with --tag option and update applicable actions
  if (hasTagSelector) {
    allActions
      .filter(action => action.tags.some(tag => runConfig.tags.includes(tag)))
      .forEach(action => includedActionNames.add(targetAsReadableString(action.target)));
  }

  // Compute all transitive dependencies.
  if (runConfig.includeDependencies) {
    const queue = [...includedActionNames];
    while (queue.length > 0) {
      const actionName = queue.pop();
      const action = allActionsByName.get(actionName);
      const matchingDependencyNames =
        action.dependencyTargets?.length > 0
          ? utils.matchPatterns(
              action.dependencyTargets.map(dependency => targetAsReadableString(dependency)),
              [...allActionNames]
            )
          : [];
      matchingDependencyNames.forEach(dependencyName => {
        if (!includedActionNames.has(dependencyName)) {
          queue.push(dependencyName);
          includedActionNames.add(dependencyName);
        }
      });
    }
  }

  // Compute all transitive dependents.
  if (runConfig.includeDependents) {
    const queue = [...includedActionNames];
    while (queue.length > 0) {
      const actionName = queue.pop();
      const matchingDependentNames = allActions
        .filter(
          compileAction =>
            utils.matchPatterns(
              [actionName],
              compileAction.dependencyTargets?.map(dependency =>
                targetAsReadableString(dependency)
              ) || []
            ).length >= 1
        )
        .map(compileAction => targetAsReadableString(compileAction.target));
      matchingDependentNames.forEach(dependentName => {
        if (!includedActionNames.has(dependentName)) {
          queue.push(dependentName);
          includedActionNames.add(dependentName);
        }
      });
    }
  }

  return includedActionNames;
}
