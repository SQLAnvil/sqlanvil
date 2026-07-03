import { prune } from "sa/cli/api/commands/prune";
import { state } from "sa/cli/api/commands/state";
import * as dbadapters from "sa/cli/api/dbadapters";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { targetStringifier } from "sa/core/targets";
import { dataformVersion } from "sa/core/version";
import * as utils from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

export async function build(
  compiledGraph: sqlanvil.ICompiledGraph,
  runConfig: sqlanvil.IRunConfig,
  dbadapter: dbadapters.IDbAdapter
) {
  const prunedGraph = prune(compiledGraph, runConfig);

  const allInvolvedTargets = new Set<string>(
    prunedGraph.tables.map(table => targetStringifier.stringify(table.target))
  );

  return new Builder(
    prunedGraph,
    runConfig,
    await state(
      dbadapter,
      Array.from(allInvolvedTargets).map(target => targetStringifier.parse(target))
    )
  ).build();
}

export class Builder {
  private readonly executionSql: ExecutionSql;

  constructor(
    private readonly prunedGraph: sqlanvil.ICompiledGraph,
    private readonly runConfig: sqlanvil.IRunConfig,
    private readonly warehouseState: sqlanvil.IWarehouseState
  ) {
    this.executionSql = new ExecutionSql(
      prunedGraph.projectConfig,
      // Capability gating in the SQL generators (e.g. incremental pre/post-ops,
      // gated at "> 1.4.8") compares against the upstream *Dataform* version, not
      // sqlanvil's own package SemVer. Pass the Dataform base of the running core
      // so decoupling the package version (e.g. 1.0.0) doesn't disable those gates.
      dataformVersion
    );
    prunedGraph.tables.forEach(utils.setOrValidateTableEnumType);
  }

  public build(): sqlanvil.ExecutionGraph {
    if (utils.graphHasErrors(this.prunedGraph)) {
      throw new Error(`Project has unresolved compilation or validation errors.`);
    }

    const tableMetadataByTarget = new Map<string, sqlanvil.ITableMetadata>();

    this.warehouseState.tables.forEach(tableState => {
      tableMetadataByTarget.set(targetStringifier.stringify(tableState.target), tableState);
    });

    const actions: sqlanvil.IExecutionAction[] = [].concat(
      this.prunedGraph.tables.map(t =>
        this.buildTable(
          t,
          tableMetadataByTarget.get(targetStringifier.stringify(t.target)),
          this.runConfig
        )
      ),
      this.prunedGraph.operations.map(o => this.buildOperation(o)),
      this.prunedGraph.assertions.map(a => this.buildAssertion(a)),
      this.prunedGraph.exports.map(e => this.buildExport(e)),
      this.prunedGraph.imports.map(i => this.buildImport(i)),
      this.prunedGraph.extracts.map(e => this.buildExtract(e))
    );
    return sqlanvil.ExecutionGraph.create({
      projectConfig: this.prunedGraph.projectConfig,
      runConfig: this.runConfig,
      warehouseState: this.warehouseState,
      declarationTargets: this.prunedGraph.declarations.map(declaration => declaration.target),
      actions
    });
  }

  private buildTable(
    table: sqlanvil.ITable,
    tableMetadata: sqlanvil.ITableMetadata,
    runConfig: sqlanvil.IRunConfig
  ) {
    return {
      ...this.toPartialExecutionAction(table),
      type: "table",
      tableType: utils.tableTypeEnumToString(table.enumType),
      tasks: this.executionSql.createTableTasks(table, runConfig, tableMetadata),
      hermeticity: table.hermeticity || sqlanvil.ActionHermeticity.HERMETIC
    };
  }

  private buildOperation(operation: sqlanvil.IOperation) {
    return {
      ...this.toPartialExecutionAction(operation),
      type: "operation",
      tasks: this.executionSql.createOperationTasks(operation),
      hermeticity: operation.hermeticity || sqlanvil.ActionHermeticity.NON_HERMETIC
    };
  }

  private buildAssertion(assertion: sqlanvil.IAssertion) {
    return {
      ...this.toPartialExecutionAction(assertion),
      type: "assertion",
      tasks: this.executionSql.createAssertionTasks(assertion),
      hermeticity: assertion.hermeticity || sqlanvil.ActionHermeticity.HERMETIC
    };
  }

  private buildExport(exp: sqlanvil.IExport) {
    return {
      ...this.toPartialExecutionAction(exp),
      type: "export",
      tasks: this.executionSql.createExportTasks(exp),
      hermeticity: exp.hermeticity || sqlanvil.ActionHermeticity.NON_HERMETIC,
      export: sqlanvil.ExportSpec.create({
        query: exp.query,
        location: exp.location,
        format: exp.format,
        overwrite: exp.overwrite,
        filename: exp.filename,
        options: exp.options
      })
    };
  }

  private buildImport(imp: sqlanvil.IImport) {
    return {
      ...this.toPartialExecutionAction(imp),
      type: "import",
      tasks: this.executionSql.createImportTasks(imp),
      hermeticity: imp.hermeticity || sqlanvil.ActionHermeticity.NON_HERMETIC,
      import: sqlanvil.ImportSpec.create({
        location: imp.location,
        format: imp.format,
        overwrite: imp.overwrite,
        options: imp.options
      })
    };
  }

  private buildExtract(ext: sqlanvil.IExtract) {
    // No warehouse SQL: the "extract" task is a marker; the run-time seam reads the cross-warehouse
    // source (keyless BigQuery) and materializes the rows into the target from the ExtractSpec.
    return {
      ...this.toPartialExecutionAction(ext),
      type: "extract",
      tasks: ext.disabled ? [] : [sqlanvil.ExecutionTask.create({ type: "extract", statement: "" })],
      hermeticity: ext.hermeticity || sqlanvil.ActionHermeticity.NON_HERMETIC,
      extract: sqlanvil.ExtractSpec.create({
        connectionName: ext.connectionName,
        platform: ext.platform,
        project: ext.project,
        dataset: ext.dataset,
        database: ext.database,
        sourceName: ext.sourceName,
        billingProject: ext.billingProject,
        columnTypes: ext.columnTypes
      })
    };
  }

  private toPartialExecutionAction(
    action:
      | sqlanvil.ITable
      | sqlanvil.IOperation
      | sqlanvil.IAssertion
      | sqlanvil.IExport
      | sqlanvil.IImport
      | sqlanvil.IExtract
  ) {
    return sqlanvil.ExecutionAction.create({
      target: action.target,
      fileName: action.fileName,
      dependencyTargets: action.dependencyTargets,
      actionDescriptor: action.actionDescriptor
    });
  }
}
