import { targetAsReadableString, targetStringifier } from "sa/core/targets";
import { sqlanvil } from "sa/protos/ts";

/**
 * Pure shaping of a compiled graph + run result into flat rows for the queryable Parquet
 * artifacts. No DuckDB, no I/O — unit-testable on its own.
 */

export interface ActionRow {
  target_key: string;
  database: string;
  schema: string;
  name: string;
  readable_name: string;
  type: string; // table | view | incremental | operation | assertion | export | declaration
  tags: string; // JSON array string
  disabled: boolean;
  file_name: string;
  description: string;
}

export interface DependencyRow {
  from_target_key: string;
  to_target_key: string;
  from_readable: string;
  to_readable: string;
}

export interface ColumnRow {
  target_key: string;
  readable_name: string;
  column_name: string;
  description: string;
}

export interface CatalogRows {
  actions: ActionRow[];
  dependencies: DependencyRow[];
  columns: ColumnRow[];
}

export interface RunRow {
  run_id: number;
  run_status: string;
  target_key: string;
  readable_name: string;
  status: string;
  start_millis: number;
  end_millis: number;
  duration_millis: number;
  error_message: string;
}

function key(target: sqlanvil.ITarget): string {
  return targetStringifier.stringify(target);
}

// protobufjs enums are plain { NAME: number } objects — reverse-map a value to its name.
function enumName(enumObject: { [k: string]: number }, value: number | undefined): string {
  if (value === undefined || value === null) {
    return "UNKNOWN";
  }
  const match = Object.keys(enumObject).find(k => enumObject[k] === value);
  return match || String(value);
}

function tableType(enumType: sqlanvil.TableType | undefined): string {
  switch (enumType) {
    case sqlanvil.TableType.VIEW:
      return "view";
    case sqlanvil.TableType.INCREMENTAL:
      return "incremental";
    default:
      return "table";
  }
}

function toMillis(value: any): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value) || 0;
}

function actionRow(action: any, type: string): ActionRow {
  const descriptor = action.actionDescriptor || {};
  return {
    target_key: key(action.target),
    database: action.target.database || "",
    schema: action.target.schema || "",
    name: action.target.name || "",
    readable_name: targetAsReadableString(action.target),
    type,
    tags: JSON.stringify(action.tags || []),
    disabled: !!action.disabled,
    file_name: action.fileName || "",
    description: descriptor.description || ""
  };
}

function pushDeps(action: any, out: DependencyRow[]): void {
  for (const dep of action.dependencyTargets || []) {
    out.push({
      from_target_key: key(action.target),
      to_target_key: key(dep),
      from_readable: targetAsReadableString(action.target),
      to_readable: targetAsReadableString(dep)
    });
  }
}

function pushColumns(action: any, out: ColumnRow[]): void {
  const columns = (action.actionDescriptor && action.actionDescriptor.columns) || [];
  for (const column of columns) {
    out.push({
      target_key: key(action.target),
      readable_name: targetAsReadableString(action.target),
      column_name: (column.path || []).join("."),
      description: column.description || ""
    });
  }
}

/** Flatten a compiled graph into catalog rows (actions, dependency edges, column descriptors). */
export function catalogRows(compiledGraph: sqlanvil.ICompiledGraph): CatalogRows {
  const actions: ActionRow[] = [];
  const dependencies: DependencyRow[] = [];
  const columns: ColumnRow[] = [];

  const add = (action: any, type: string) => {
    actions.push(actionRow(action, type));
    pushDeps(action, dependencies);
    pushColumns(action, columns);
  };

  for (const table of compiledGraph.tables || []) {
    add(table, tableType(table.enumType));
  }
  for (const operation of compiledGraph.operations || []) {
    add(operation, "operation");
  }
  for (const assertion of compiledGraph.assertions || []) {
    add(assertion, "assertion");
  }
  for (const exp of compiledGraph.exports || []) {
    add(exp, "export");
  }
  for (const imp of compiledGraph.imports || []) {
    add(imp, "import");
  }
  for (const declaration of compiledGraph.declarations || []) {
    add(declaration, "declaration");
  }

  return { actions, dependencies, columns };
}

/** Flatten a run result into one row per action result. */
export function runRows(runResult: sqlanvil.IRunResult, runId: number): RunRow[] {
  const runStatus = enumName(
    sqlanvil.RunResult.ExecutionStatus as any,
    runResult.status as any
  );
  return (runResult.actions || []).map(action => {
    const start = toMillis(action.timing && action.timing.startTimeMillis);
    const end = toMillis(action.timing && action.timing.endTimeMillis);
    const failedTask = (action.tasks || []).find(t => !!t.errorMessage);
    return {
      run_id: runId,
      run_status: runStatus,
      target_key: key(action.target),
      readable_name: targetAsReadableString(action.target),
      status: enumName(sqlanvil.ActionResult.ExecutionStatus as any, action.status as any),
      start_millis: start,
      end_millis: end,
      duration_millis: start && end ? end - start : 0,
      error_message: (failedTask && failedTask.errorMessage) || ""
    };
  });
}
