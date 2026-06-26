import { expect } from "chai";

import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

const imp = (o: any) =>
  sqlanvil.Import.create({
    target: { schema: "analytics", name: "orders" },
    overwrite: true,
    ...o
  });

suite("createImportTasks", () => {
  test("BigQuery renders LOAD DATA OVERWRITE from gs:// files", () => {
    const sql = new ExecutionSql({ warehouse: "bigquery", defaultDatabase: "proj" } as any, "1.11.0");
    const [task] = sql.createImportTasks(
      imp({ location: "gs://b/orders/*.parquet", format: "parquet" })
    );
    expect(task.type).equals("statement");
    expect(task.statement).contains("LOAD DATA OVERWRITE");
    expect(task.statement).contains("format = 'PARQUET'");
    expect(task.statement).contains("uris = ['gs://b/orders/*.parquet']");
  });

  test("BigQuery uses LOAD DATA INTO for append (overwrite:false)", () => {
    const sql = new ExecutionSql({ warehouse: "bigquery", defaultDatabase: "proj" } as any, "1.11.0");
    const [task] = sql.createImportTasks(
      imp({ location: "gs://b/orders/*.csv", format: "csv", overwrite: false })
    );
    expect(task.statement).contains("LOAD DATA INTO");
  });

  test("Postgres emits an import-type marker task", () => {
    const sql = new ExecutionSql({ warehouse: "postgres" } as any, "1.11.0");
    const [task] = sql.createImportTasks(imp({ location: "s3://b/o/*.parquet", format: "parquet" }));
    expect(task.type).equals("import");
  });

  test("Supabase inherits the Postgres import task", () => {
    const sql = new ExecutionSql({ warehouse: "supabase" } as any, "1.11.0");
    const [task] = sql.createImportTasks(imp({ location: "s3://b/o/*.json", format: "json" }));
    expect(task.type).equals("import");
  });

  test("MySQL throws (not supported yet)", () => {
    const sql = new ExecutionSql({ warehouse: "mysql" } as any, "1.11.0");
    expect(() =>
      sql.createImportTasks(imp({ location: "local:///tmp/o.parquet", format: "parquet" }))
    ).to.throw("not supported on MySQL");
  });

  test("disabled import yields no tasks", () => {
    const sql = new ExecutionSql({ warehouse: "bigquery" } as any, "1.11.0");
    expect(
      sql.createImportTasks(
        imp({ location: "gs://b/o/*.parquet", format: "parquet", disabled: true })
      )
    ).to.have.length(0);
  });
});
