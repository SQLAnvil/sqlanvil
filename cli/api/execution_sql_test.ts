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

  test("validate: table stub wraps the query + LIMIT 0 (BigQuery)", () => {
    expect(
      executionSql.validationStubSql({
        enumType: sqlanvil.TableType.TABLE,
        target: { database: "project-id", schema: "dataset-id", name: "x" },
        query: "select 1 as id"
      })
    ).to.equal("create table `project-id.dataset-id.x` as select * from (select 1 as id) limit 0");
  });

  test("validate: view stub is CREATE VIEW (BigQuery)", () => {
    expect(
      executionSql.validationStubSql({
        enumType: sqlanvil.TableType.VIEW,
        target: { database: "project-id", schema: "dataset-id", name: "x" },
        query: "select 1 as id"
      })
    ).to.equal("create view `project-id.dataset-id.x` as select 1 as id");
  });

  test("validate: shadow dataset create/drop are project-qualified + cascade (BigQuery)", () => {
    expect(executionSql.createSchemaSql("dataset-id__sqlanvil_validate_1")).to.equal(
      "create schema if not exists `project-id.dataset-id__sqlanvil_validate_1`"
    );
    expect(executionSql.dropSchemaCascadeSql("dataset-id__sqlanvil_validate_1")).to.equal(
      "drop schema if exists `project-id.dataset-id__sqlanvil_validate_1` cascade"
    );
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

  test("create index without a name derives one (no zero-length identifier)", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        indexes: [
          { columns: ["id"] },
          { columns: ["field1", "id"], unique: true }
        ]
      }
    };
    const statements = executionSql
      .publishTasks(table, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    // Names are derived as <table>_<cols>_idx (or _key for unique) -- never "".
    expect(statements).to.not.include.members([
      'create index "" on "my_db"."public"."my_table" using btree ("id")'
    ]);
    expect(statements[2]).to.equal(
      'create index "my_table_id_idx" on "my_db"."public"."my_table" using btree ("id")'
    );
    expect(statements[3]).to.equal(
      'create unique index "my_table_field1_id_key" on "my_db"."public"."my_table" using btree ("field1", "id")'
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

  test("partitioned parent honors tablespace", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        tablespace: "fast_ssd",
        partition: {
          kind: sqlanvil.PostgresOptions.Partition.Kind.RANGE,
          columns: ["id"],
          partitions: [{ name: "p0", values: "FROM (0) TO (100)" }]
        }
      }
    };
    const statements = executionSql
      .publishTasks(table, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(statements).to.include(
      'create table "my_db"."public"."my_table" (like "my_db"."public"."my_table__sa_stage" including defaults) partition by range ("id") tablespace "fast_ssd"'
    );
  });

  test("sub-partitioned child emits a nested PARTITION BY and its sub-partitions", () => {
    const table: sqlanvil.ITable = {
      ...baseTable,
      postgres: {
        partition: {
          kind: sqlanvil.PostgresOptions.Partition.Kind.RANGE,
          columns: ["id"],
          partitions: [
            {
              name: "p0",
              values: "FROM (0) TO (100)",
              subPartition: {
                kind: sqlanvil.PostgresOptions.Partition.Kind.LIST,
                columns: ["field1"],
                partitions: [{ name: "us", values: "IN ('a')" }]
              }
            }
          ]
        }
      }
    };
    const statements = executionSql
      .publishTasks(table, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(statements).to.include(
      'create table "my_db"."public"."my_table__p0" partition of "my_db"."public"."my_table" for values FROM (0) TO (100) partition by list ("field1")'
    );
    expect(statements).to.include(
      'create table "my_db"."public"."my_table__p0__us" partition of "my_db"."public"."my_table__p0" for values IN (\'a\')'
    );
  });

  test("materialized view honors no_data (WITH NO DATA)", () => {
    const mvTable: sqlanvil.ITable = {
      ...baseTable,
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      postgres: { noData: true }
    };
    const statements = executionSql
      .publishTasks(mvTable, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(statements[1]).to.equal(
      'create materialized view "my_db"."public"."my_table" as select 1 as id, \'a\' as field1 with no data'
    );
  });

  test("materialized view refreshes in place when it exists and refresh_policy is set", () => {
    const mvTable: sqlanvil.ITable = {
      ...baseTable,
      type: "view",
      enumType: sqlanvil.TableType.VIEW,
      materialized: true,
      postgres: { refreshPolicy: "on_dependency_change" }
    };
    const existing: sqlanvil.ITableMetadata = {
      type: sqlanvil.TableMetadata.Type.MATERIALIZED_VIEW,
      fields: []
    };
    const statements = executionSql
      .publishTasks(mvTable, { fullRefresh: false }, existing)
      .build()
      .map(t => t.statement);
    expect(statements).to.eql(['refresh materialized view "my_db"."public"."my_table"']);
  });

  test("incremental post-ops: one-time DDL runs on create, not on incremental append", () => {
    const incTable: sqlanvil.ITable = {
      type: "incremental",
      enumType: sqlanvil.TableType.INCREMENTAL,
      target: { schema: "public", name: "my_table" },
      query: "select 1 as id",
      incrementalQuery: "select 1 as id",
      uniqueKey: ["id"],
      preOps: ["create-time preop"],
      postOps: ["alter table add primary key (id)"], // one-time DDL
      incrementalPreOps: ["append preop"],
      incrementalPostOps: ["append postop"]
    };
    const tableMetadata: sqlanvil.ITableMetadata = {
      type: sqlanvil.TableMetadata.Type.TABLE,
      fields: [{ name: "id", primitive: sqlanvil.Field.Primitive.INTEGER }]
    };

    // Create / full-refresh (no existing table): plain preOps/postOps run, so the
    // ADD PRIMARY KEY happens exactly once when the table is built.
    const created = executionSql
      .publishTasks(incTable, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(created).to.include("create-time preop");
    expect(created).to.include("alter table add primary key (id)");
    expect(created).to.not.include("append postop");

    // Incremental append (table already exists): incremental*Ops run, and the
    // one-time ADD PRIMARY KEY is NOT re-issued (which would error).
    const appended = executionSql
      .publishTasks(incTable, { fullRefresh: false }, tableMetadata)
      .build()
      .map(t => t.statement);
    expect(appended).to.include("append preop");
    expect(appended).to.include("append postop");
    expect(appended).to.not.include("alter table add primary key (id)");
  });

  test("validate: table stub is CREATE TABLE … WITH NO DATA", () => {
    expect(executionSql.validationStubSql(baseTable)).to.equal(
      'create table "my_db"."public"."my_table" as select 1 as id, \'a\' as field1 with no data'
    );
  });

  test("validate: view stub is CREATE VIEW", () => {
    const view = { ...baseTable, enumType: sqlanvil.TableType.VIEW };
    expect(executionSql.validationStubSql(view)).to.equal(
      'create view "my_db"."public"."my_table" as select 1 as id, \'a\' as field1'
    );
  });

  test("validate: schema create/drop are isolated + cascade", () => {
    expect(executionSql.createSchemaSql("public__sqlanvil_validate_1")).to.equal(
      'create schema if not exists "public__sqlanvil_validate_1"'
    );
    expect(executionSql.dropSchemaCascadeSql("public__sqlanvil_validate_1")).to.equal(
      'drop schema if exists "public__sqlanvil_validate_1" cascade'
    );
  });
});

suite("mysql execution sql", () => {
  const project: sqlanvil.IProjectConfig = { warehouse: "mysql" };
  const sql = new ExecutionSql(project, "1.5.0");
  const baseTable = (over: Partial<sqlanvil.ITable> = {}): sqlanvil.ITable => ({
    target: { schema: "db", name: "t" },
    query: "select 1 as id",
    enumType: sqlanvil.TableType.TABLE,
    ...over
  });

  test("table: drop + CTAS with backticks", () => {
    const stmts = sql
      .publishTasks(baseTable(), { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(stmts).to.include("drop table if exists `db`.`t`");
    expect(stmts).to.include("create table `db`.`t` as select 1 as id");
  });

  test("view: CREATE OR REPLACE VIEW", () => {
    const stmts = sql
      .publishTasks(baseTable({ enumType: sqlanvil.TableType.VIEW }), { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(stmts).to.include("create or replace view `db`.`t` as select 1 as id");
  });

  test("incremental fresh-create adds a unique index on the uniqueKey", () => {
    const stmts = sql
      .publishTasks(
        baseTable({ enumType: sqlanvil.TableType.INCREMENTAL, uniqueKey: ["id"] }),
        { fullRefresh: true }
      )
      .build()
      .map(t => t.statement);
    expect(stmts.some(s => /alter table `db`\.`t` add unique index .* \(`id`\)/.test(s))).to.equal(
      true
    );
  });

  test("incremental append upserts via ON DUPLICATE KEY UPDATE", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          enumType: sqlanvil.TableType.INCREMENTAL,
          uniqueKey: ["id"],
          incrementalQuery: "select 1 as id"
        }),
        { fullRefresh: false },
        {
          target: { schema: "db", name: "t" },
          type: sqlanvil.TableMetadata.Type.TABLE,
          fields: [{ name: "id" }, { name: "v" }]
        }
      )
      .build()
      .map(t => t.statement);
    expect(
      stmts.some(s => s.includes("on duplicate key update") && s.includes("`v` = values(`v`)"))
    ).to.equal(true);
  });

  test("materialized view builds a refreshed table snapshot (drop view+table, CTAS)", () => {
    const stmts = sql
      .publishTasks(
        baseTable({ enumType: sqlanvil.TableType.VIEW, materialized: true }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts).to.include("drop view if exists `db`.`t`");
    expect(stmts).to.include("drop table if exists `db`.`t`");
    expect(stmts).to.include("create table `db`.`t` as select 1 as id");
    expect(stmts.some(s => /create or replace view/.test(s))).to.equal(false);
  });

  test("materialized view honors the mysql:{} block (engine + indexes)", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          enumType: sqlanvil.TableType.VIEW,
          materialized: true,
          mysql: { engine: "InnoDB", indexes: [{ name: "ix_id", columns: ["id"] }] }
        }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts.some(s => /create table `db`\.`t` engine=InnoDB as /.test(s))).to.equal(true);
    expect(stmts).to.include("alter table `db`.`t` add index `ix_id` (`id`)");
  });

  test("table options: engine + charset land in the CTAS", () => {
    const stmts = sql
      .publishTasks(baseTable({ mysql: { engine: "InnoDB", charset: "utf8mb4" } }), {
        fullRefresh: false
      })
      .build()
      .map(t => t.statement);
    expect(
      stmts.some(s => /create table `db`\.`t` engine=InnoDB default charset=utf8mb4 as /.test(s))
    ).to.equal(true);
  });

  test("indexes emit ALTER TABLE ADD INDEX after the CTAS", () => {
    const stmts = sql
      .publishTasks(
        baseTable({ mysql: { indexes: [{ name: "ix_label", columns: ["label"] }] } }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts).to.include("alter table `db`.`t` add index `ix_label` (`label`)");
  });

  test("unique index emits ADD UNIQUE INDEX with a derived name when unnamed", () => {
    const stmts = sql
      .publishTasks(baseTable({ mysql: { indexes: [{ columns: ["id"], unique: true }] } }), {
        fullRefresh: false
      })
      .build()
      .map(t => t.statement);
    expect(stmts).to.include("alter table `db`.`t` add unique index `t_id_key` (`id`)");
  });

  test("incremental fresh-create carries table options and user indexes alongside the uniqueKey index", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          enumType: sqlanvil.TableType.INCREMENTAL,
          uniqueKey: ["id"],
          mysql: { engine: "InnoDB", indexes: [{ name: "ix_label", columns: ["label"] }] }
        }),
        { fullRefresh: true }
      )
      .build()
      .map(t => t.statement);
    // CTAS on the fresh-create path carries the engine option.
    expect(stmts.some(s => /create table `db`\.`t` engine=InnoDB as /.test(s))).to.equal(true);
    // The auto uniqueKey unique index is still emitted.
    expect(stmts.some(s => /add unique index `uq_db_t` \(`id`\)/.test(s))).to.equal(true);
    // The user-declared index is additive.
    expect(stmts).to.include("alter table `db`.`t` add index `ix_label` (`label`)");
  });

  test("table pre_operations / post_operations run around the build (issue #44)", () => {
    const stmts = sql
      .publishTasks(
        baseTable({ preOps: ["set @x = 1"], postOps: ["analyze table `db`.`t`"] }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts[0]).to.equal("set @x = 1");
    expect(stmts[stmts.length - 1]).to.equal("analyze table `db`.`t`");
    // Ops bracket the create: preOp before the CTAS, postOp after.
    expect(stmts.indexOf("set @x = 1")).to.be.lessThan(
      stmts.findIndex(s => s.startsWith("create table"))
    );
  });

  test("view pre_operations / post_operations run around CREATE OR REPLACE VIEW", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          enumType: sqlanvil.TableType.VIEW,
          preOps: ["set @v = 1"],
          postOps: ["set @v = 2"]
        }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts).to.eql([
      "set @v = 1",
      "create or replace view `db`.`t` as select 1 as id",
      "set @v = 2"
    ]);
  });

  test("incremental: one-time post-op runs on create, incremental* ops on append (issue #44)", () => {
    const incTable = baseTable({
      enumType: sqlanvil.TableType.INCREMENTAL,
      uniqueKey: ["id"],
      incrementalQuery: "select 1 as id",
      preOps: ["create-time preop"],
      postOps: ["alter table `db`.`t` add primary key (`id`)"], // one-time DDL
      incrementalPreOps: ["append preop"],
      incrementalPostOps: ["append postop"]
    });

    // Create / full-refresh (no existing table): plain preOps/postOps run.
    const created = sql
      .publishTasks(incTable, { fullRefresh: false })
      .build()
      .map(t => t.statement);
    expect(created).to.include("create-time preop");
    expect(created).to.include("alter table `db`.`t` add primary key (`id`)");
    expect(created).to.not.include("append postop");

    // Incremental append (table already exists): incremental* ops run, one-time DDL does not.
    const appended = sql
      .publishTasks(incTable, { fullRefresh: false }, {
        target: { schema: "db", name: "t" },
        type: sqlanvil.TableMetadata.Type.TABLE,
        fields: [{ name: "id" }]
      })
      .build()
      .map(t => t.statement);
    expect(appended).to.include("append preop");
    expect(appended).to.include("append postop");
    expect(appended).to.not.include("alter table `db`.`t` add primary key (`id`)");
  });

  test("partition: RANGE emits explicit child definitions after table options", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          mysql: {
            engine: "InnoDB",
            partition: {
              kind: sqlanvil.MysqlOptions.Partition.Kind.RANGE,
              expression: "id",
              partitions: [
                { name: "p0", values: "values less than (10)" },
                { name: "pmax", values: "values less than maxvalue" }
              ]
            }
          }
        }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(stmts).to.include(
      "create table `db`.`t` engine=InnoDB partition by range (id) " +
        "(partition p0 values less than (10), partition pmax values less than maxvalue) as select 1 as id"
    );
  });

  test("partition: HASH/KEY emit PARTITIONS <n>", () => {
    const hash = sql
      .publishTasks(
        baseTable({
          mysql: { partition: { kind: sqlanvil.MysqlOptions.Partition.Kind.HASH, expression: "id", count: 4 } }
        }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(hash).to.include("create table `db`.`t` partition by hash (id) partitions 4 as select 1 as id");

    const key = sql
      .publishTasks(
        baseTable({
          mysql: { partition: { kind: sqlanvil.MysqlOptions.Partition.Kind.KEY, expression: "id", count: 2 } }
        }),
        { fullRefresh: false }
      )
      .build()
      .map(t => t.statement);
    expect(key).to.include("create table `db`.`t` partition by key (id) partitions 2 as select 1 as id");
  });

  test("partition: applies on the incremental fresh-create path", () => {
    const stmts = sql
      .publishTasks(
        baseTable({
          enumType: sqlanvil.TableType.INCREMENTAL,
          uniqueKey: ["id"],
          mysql: {
            partition: {
              kind: sqlanvil.MysqlOptions.Partition.Kind.RANGE,
              expression: "id",
              partitions: [{ name: "pmax", values: "values less than maxvalue" }]
            }
          }
        }),
        { fullRefresh: true }
      )
      .build()
      .map(t => t.statement);
    expect(stmts.some(s => /partition by range \(id\) \(partition pmax values less than maxvalue\) as /.test(s))).to.equal(
      true
    );
  });

  test("validate: table stub wraps the query + LIMIT 0", () => {
    expect(sql.validationStubSql(baseTable())).to.equal(
      "create table `db`.`t` as select * from (select 1 as id) as _sa_stub limit 0"
    );
  });

  test("validate: view stub is CREATE OR REPLACE VIEW", () => {
    expect(sql.validationStubSql(baseTable({ enumType: sqlanvil.TableType.VIEW }))).to.equal(
      "create or replace view `db`.`t` as select 1 as id"
    );
  });

  test("validate: shadow schema is a CREATE/DROP DATABASE", () => {
    expect(sql.createSchemaSql("db__sqlanvil_validate_1")).to.equal(
      "create database if not exists `db__sqlanvil_validate_1`"
    );
    expect(sql.dropSchemaCascadeSql("db__sqlanvil_validate_1")).to.equal(
      "drop database if exists `db__sqlanvil_validate_1`"
    );
  });
});

