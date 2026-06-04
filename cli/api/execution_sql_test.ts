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

suite("ExecutionSql with Postgres/Supabase", () => {
  const executionSql = new ExecutionSql(
    {
      warehouse: "postgres",
      defaultDatabase: "my_db",
      defaultSchema: "public"
    },
    "2.0.0"
  );

  const baseTable: sqlanvil.ITable = {
    type: "table",
    enumType: sqlanvil.TableType.TABLE,
    target: {
      schema: "public",
      name: "my_table"
    },
    query: "select 1 as id, 'a' as field1"
  };

  test("generates drop and create table", () => {
    const tasks = executionSql.publishTasks(baseTable, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(2);
    expect(statements[0]).to.equal('drop table if exists "my_db"."public"."my_table" cascade');
    expect(statements[1]).to.equal('create table "my_db"."public"."my_table" as select 1 as id, \'a\' as field1');
  });

  test("generates drop and create view", () => {
    const viewTable = {
      ...baseTable,
      type: "view",
      enumType: sqlanvil.TableType.VIEW
    };
    const tasks = executionSql.publishTasks(viewTable, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(2);
    expect(statements[0]).to.equal('drop view if exists "my_db"."public"."my_table" cascade');
    expect(statements[1]).to.equal('create view "my_db"."public"."my_table" as select 1 as id, \'a\' as field1');
  });

  test("generates incremental insert (no unique keys)", () => {
    const incTable = {
      ...baseTable,
      type: "incremental",
      enumType: sqlanvil.TableType.INCREMENTAL
    };
    const tableMetadata: sqlanvil.ITableMetadata = {
      type: sqlanvil.TableMetadata.Type.TABLE,
      fields: [
        { name: "id", primitive: sqlanvil.Field.Primitive.INTEGER },
        { name: "field1", primitive: sqlanvil.Field.Primitive.STRING }
      ]
    };
    const tasks = executionSql.publishTasks(incTable, { fullRefresh: false }, tableMetadata);
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(1);
    expect(statements[0]).to.equal(
      'insert into "my_db"."public"."my_table" ("id", "field1") select "id", "field1" from (select 1 as id, \'a\' as field1) as insertions'
    );
  });

  test("generates incremental upsert (with unique keys)", () => {
    const incTable = {
      ...baseTable,
      type: "incremental",
      enumType: sqlanvil.TableType.INCREMENTAL,
      uniqueKey: ["id"]
    };
    const tableMetadata: sqlanvil.ITableMetadata = {
      type: sqlanvil.TableMetadata.Type.TABLE,
      fields: [
        { name: "id", primitive: sqlanvil.Field.Primitive.INTEGER },
        { name: "field1", primitive: sqlanvil.Field.Primitive.STRING }
      ]
    };
    const tasks = executionSql.publishTasks(incTable, { fullRefresh: false }, tableMetadata);
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(1);
    expect(statements[0]).to.equal(
      'insert into "my_db"."public"."my_table" ("id", "field1") select "id", "field1" from (select 1 as id, \'a\' as field1) as insertions on conflict ("id") do update set "field1" = EXCLUDED."field1"'
    );
  });

  test("create table applies postgres storage options (unlogged, fillfactor, tablespace)", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: { unlogged: true, fillfactor: 70, tablespace: "fast_ssd" }
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements[1]).to.equal(
      'create unlogged table "my_db"."public"."my_table" with (fillfactor=70) tablespace "fast_ssd" as select 1 as id, \'a\' as field1'
    );
  });

  test("create table emits postgres indexes as separate statements", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        indexes: [
          {
            name: "ix_my_table_id",
            columns: ["id"],
            method: sqlanvil.PostgresOptions.Index.Method.BTREE
          },
          {
            name: "ix_my_table_field1",
            columns: ["field1"],
            method: sqlanvil.PostgresOptions.Index.Method.GIN,
            unique: true,
            include: ["id"],
            where: "field1 is not null"
          }
        ]
      }
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(4);
    expect(statements[2]).to.equal(
      'create index "ix_my_table_id" on "my_db"."public"."my_table" using btree ("id")'
    );
    expect(statements[3]).to.equal(
      'create unique index "ix_my_table_field1" on "my_db"."public"."my_table" using gin ("field1") include ("id") where (field1 is not null)'
    );
  });

  test("incremental fresh-create emits postgres indexes", () => {
    const incTable: sqlanvil.ITable = {
      ...baseTable,
      type: "incremental",
      enumType: sqlanvil.TableType.INCREMENTAL,
      postgres: {
        indexes: [
          { name: "ix_inc", columns: ["id"], method: sqlanvil.PostgresOptions.Index.Method.BRIN }
        ]
      }
    };
    // No tableMetadata -> the table doesn't exist yet -> fresh create path.
    const tasks = executionSql.publishTasks(incTable, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.include(
      'create index "ix_inc" on "my_db"."public"."my_table" using brin ("id")'
    );
  });

  test("materialized view emits CREATE MATERIALIZED VIEW", () => {
    const mvTable: sqlanvil.ITable = {
      ...baseTable,
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true
    };
    const tasks = executionSql.publishTasks(mvTable, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.have.lengthOf(2);
    expect(statements[0]).to.equal(
      'drop materialized view if exists "my_db"."public"."my_table" cascade'
    );
    expect(statements[1]).to.equal(
      'create materialized view "my_db"."public"."my_table" as select 1 as id, \'a\' as field1'
    );
  });

  test("create index applies a per-column operator class", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        indexes: [
          {
            name: "ix_doc_trgm",
            columns: ["field1"],
            method: sqlanvil.PostgresOptions.Index.Method.GIN,
            opclass: "gin_trgm_ops"
          }
        ]
      }
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements[2]).to.equal(
      'create index "ix_doc_trgm" on "my_db"."public"."my_table" using gin ("field1" gin_trgm_ops)'
    );
  });

  test("partitioned table builds via a staging table + child partitions", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        partition: {
          kind: sqlanvil.PostgresOptions.Partition.Kind.RANGE,
          columns: ["id"],
          partitions: [{ name: "p0", values: "FROM (0) TO (100)" }],
          includeDefault: true
        }
      }
    };
    const tasks = executionSql.publishTasks(table, { fullRefresh: false });
    const statements = tasks.build().map(t => t.statement);
    expect(statements).to.eql([
      'drop table if exists "my_db"."public"."my_table__sa_stage" cascade',
      'create unlogged table "my_db"."public"."my_table__sa_stage" as select 1 as id, \'a\' as field1 with no data',
      'drop table if exists "my_db"."public"."my_table" cascade',
      'create table "my_db"."public"."my_table" (like "my_db"."public"."my_table__sa_stage" including defaults) partition by range ("id")',
      'create table "my_db"."public"."my_table__p0" partition of "my_db"."public"."my_table" for values FROM (0) TO (100)',
      'create table "my_db"."public"."my_table__default" partition of "my_db"."public"."my_table" default',
      'insert into "my_db"."public"."my_table" select * from (select 1 as id, \'a\' as field1) as q',
      'drop table if exists "my_db"."public"."my_table__sa_stage" cascade'
    ]);
  });
});

