import { expect } from "chai";
import * as fs from "fs-extra";

import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("ExecutionSql with 'onSchemaChange'", () => {
  const executionSql = new ExecutionSql(
    {
      defaultDatabase: "project-id",
      defaultSchema: "dataset-id"
    },
    "2.0.0",
    () => "test_uuid"
  );

  const baseTable: sqlanvil.ITable = {
    type: "incremental",
    enumType: sqlanvil.TableType.INCREMENTAL,
    target: {
      database: "project-id",
      schema: "dataset-id",
      name: "incremental_on_schema_change"
    },
    query: "select 1 as id, 'a' as field1",
    incrementalQuery: "select 1 as id, 'a' as field1, 'new' as field2"
  };

  const tableMetadata: sqlanvil.ITableMetadata = {
    type: sqlanvil.TableMetadata.Type.TABLE,
    fields: [
      {
        name: "id",
        primitive: sqlanvil.Field.Primitive.INTEGER
      },
      {
        name: "field1",
        primitive: sqlanvil.Field.Primitive.STRING
      }
    ]
  };

  test("generates procedure for FAIL strategy", () => {
    const table = {
      ...baseTable,
      onSchemaChange: sqlanvil.OnSchemaChange.FAIL
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false }, tableMetadata);
    const procedureSql = tasks.build().map(t => t.statement).join("\n;\n");
    const expectedSql = fs.readFileSync("cli/api/goldens/on_schema_change_fail.sql", "utf8");
    expect(procedureSql).to.equal(expectedSql.trim());
  });

  test("generates procedure for EXTEND strategy", () => {
    const table = {
      ...baseTable,
      onSchemaChange: sqlanvil.OnSchemaChange.EXTEND
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false }, tableMetadata);
    const procedureSql = tasks.build().map(t => t.statement).join("\n;\n");
    const expectedSql = fs.readFileSync("cli/api/goldens/on_schema_change_extend.sql", "utf8");
    expect(procedureSql).to.equal(expectedSql.trim());
  });

  test("generates procedure for SYNCHRONIZE strategy", () => {
    const table = {
      ...baseTable,
      onSchemaChange: sqlanvil.OnSchemaChange.SYNCHRONIZE,
      uniqueKey: ["id"]
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false }, tableMetadata);
    const procedureSql = tasks.build().map(t => t.statement).join("\n;\n");
    const expectedSql = fs.readFileSync("cli/api/goldens/on_schema_change_synchronize.sql", "utf8");
    expect(procedureSql).to.equal(expectedSql.trim());
  });

  test("generates simple merge for IGNORE strategy", () => {
    const table = {
      ...baseTable,
      onSchemaChange: sqlanvil.OnSchemaChange.IGNORE,
      uniqueKey: ["id"]
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false }, tableMetadata);
    const procedureSql = tasks.build().map(t => t.statement).join("\n;\n");
    const expectedSql = fs.readFileSync("cli/api/goldens/on_schema_change_ignore.sql", "utf8");
    expect(procedureSql).to.equal(expectedSql.trim());
  });
});
