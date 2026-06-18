import { expect } from "chai";

import { ExecutionSql } from "sa/cli/api/dbadapters/execution_sql";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

const exp = (o: any) =>
  sqlanvil.Export.create({
    target: { name: "orders" },
    query: "SELECT 1 AS id",
    overwrite: true,
    ...o
  });

suite("createExportTasks", () => {
  test("BigQuery renders EXPORT DATA with required _* and format", () => {
    const sql = new ExecutionSql({ warehouse: "bigquery" } as any, "1.8.0");
    const [task] = sql.createExportTasks(exp({ location: "gs://b/orders/", format: "parquet" }));
    expect(task.type).equals("statement");
    expect(task.statement).contains("EXPORT DATA OPTIONS(");
    expect(task.statement).contains("uri='gs://b/orders/orders_*.parquet'");
    expect(task.statement).contains("format='PARQUET'");
    expect(task.statement).contains("overwrite=true");
    expect(task.statement).contains("AS\nSELECT 1 AS id");
  });

  test("Postgres emits an export-type task carrying the SELECT", () => {
    const sql = new ExecutionSql({ warehouse: "postgres" } as any, "1.8.0");
    const [task] = sql.createExportTasks(exp({ location: "s3://b/orders/", format: "csv" }));
    expect(task.type).equals("export");
    expect(task.statement).equals("SELECT 1 AS id");
  });

  test("Supabase inherits the Postgres export task", () => {
    const sql = new ExecutionSql({ warehouse: "supabase" } as any, "1.8.0");
    const [task] = sql.createExportTasks(exp({ location: "s3://b/orders/", format: "json" }));
    expect(task.type).equals("export");
  });

  test("disabled export yields no tasks", () => {
    const sql = new ExecutionSql({ warehouse: "bigquery" } as any, "1.8.0");
    expect(
      sql.createExportTasks(exp({ location: "gs://b/o/", format: "csv", disabled: true }))
    ).to.have.length(0);
  });
});
