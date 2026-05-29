import { expect } from "chai";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { sqlanvil } from "sa/protos/ts";

import * as fs from "fs";
import * as path from "path";

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

// Automatically detect project ID from bigquery.json for BQ tests
let defaultProjectOverride: string = undefined;
try {
  if (fs.existsSync("test_credentials/bigquery.json")) {
    const creds = JSON.parse(fs.readFileSync("test_credentials/bigquery.json", "utf8"));
    if (creds && (creds.projectId || creds.project_id)) {
      defaultProjectOverride = creds.projectId || creds.project_id;
    }
  }
} catch (e) {
  // ignore
}

export async function compile(
  projectDir: string,
  schemaSuffixOverride: string,
  projectConfigOverrides?: sqlanvil.IProjectConfig
) {
  const defaultDatabase = defaultProjectOverride || projectConfigOverrides?.defaultDatabase;
  const compiledGraph = await dfapi.compile({
    projectDir,
    projectConfigOverride: { 
      schemaSuffix: schemaSuffixOverride,
      ...(defaultDatabase ? { defaultDatabase } : {})
    }
  });

  expect(compiledGraph.graphErrors.compilationErrors).to.eql([]);

  compiledGraph.projectConfig = {
    ...compiledGraph.projectConfig,
    ...projectConfigOverrides
  };
  return compiledGraph;
}
