import { targetStringifier } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";

type CoreProtoActionTypes =
  | sqlanvil.ITable
  | sqlanvil.IOperation
  | sqlanvil.IAssertion
  | sqlanvil.IDeclaration
  | sqlanvil.IDataPreparation;

function combineAllActions(graph: sqlanvil.ICompiledGraph) {
  return ([] as CoreProtoActionTypes[]).concat(
    graph.tables || ([] as sqlanvil.ITable[]),
    graph.operations || ([] as sqlanvil.IOperation[]),
    graph.assertions || ([] as sqlanvil.IAssertion[]),
    graph.declarations || ([] as sqlanvil.IDeclaration[]),
    graph.dataPreparations || ([] as sqlanvil.IDataPreparation[])
  );
}

export function actionsByTarget(compiledGraph: sqlanvil.ICompiledGraph) {
  const actionsMap = new Map<string, CoreProtoActionTypes>();
  combineAllActions(compiledGraph)
    // Required for backwards compatibility with old versions of @sqlanvil/core.
    .filter(action => !!action.target)
    .forEach(action => {
      actionsMap.set(targetStringifier.stringify(action.target), action);
    });
}

export function actionsByCanonicalTarget(compiledGraph: sqlanvil.ICompiledGraph) {
  const actionsMap = new Map<string, CoreProtoActionTypes>();
  combineAllActions(compiledGraph)
    // Required for backwards compatibility with old versions of @sqlanvil/core.
    .filter(action => !!action.canonicalTarget)
    .forEach(action => {
      actionsMap.set(targetStringifier.stringify(action.canonicalTarget), action);
    });
}
