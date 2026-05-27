import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { sqlanvil } from "sa/protos/ts";

export function keyBy<V>(values: V[], keyFn: (value: V) => string): { [key: string]: V } {
  return values.reduce((map, value) => {
    map[keyFn(value)] = value;
    return map;
  }, {} as { [key: string]: V });
}

export async function dropAllTables(
  tables: sqlanvil.ITableMetadata[],
  executionSql: ExecutionSql,
  dbadapter: dbadapters.IDbAdapter
) {
  await Promise.all(
    tables.map(table => dbadapter.execute(executionSql.dropIfExists(table.target, table.type)))
  );
}

export async function getTableRows(
  target: sqlanvil.ITarget,
  executionSql: ExecutionSql,
  dbadapter: dbadapters.IDbAdapter
) {
  return (await dbadapter.execute(`SELECT * FROM ${executionSql.resolveTarget(target)}`)).rows;
}

export async function compile(
  projectDir: string,
  schemaSuffixOverride: string,
  projectConfigOverrides?: sqlanvil.IProjectConfig
) {
  const compiledGraph = await dfapi.compile({
    projectDir,
    projectConfigOverride: { schemaSuffix: schemaSuffixOverride }
  });

  expect(compiledGraph.graphErrors.compilationErrors).to.eql([]);

  compiledGraph.projectConfig = {
    ...compiledGraph.projectConfig,
    ...projectConfigOverrides
  };
  return compiledGraph;
}
