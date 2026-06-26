import { expect } from "chai";

import { buildAttachSql } from "sa/cli/api/dbadapters/duckdb_export";
import {
  buildImportSql,
  importTargetSql,
  readerForFormat
} from "sa/cli/api/dbadapters/duckdb_import";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("duckdb_import builders", () => {
  test("readerForFormat maps formats to DuckDB readers", () => {
    expect(readerForFormat("parquet")).equals("read_parquet");
    expect(readerForFormat("csv")).equals("read_csv_auto");
    expect(readerForFormat("json")).equals("read_json_auto");
    // Unknown defaults to parquet.
    expect(readerForFormat("")).equals("read_parquet");
  });

  test("importTargetSql addresses the table through the pg attach alias, double-quoted", () => {
    const sql = importTargetSql(sqlanvil.Target.create({ schema: "analytics", name: "orders" }));
    expect(sql).equals(`pg."analytics"."orders"`);
  });

  test("overwrite import drops then creates-as-select from the reader", () => {
    const target = sqlanvil.Target.create({ schema: "analytics", name: "orders" });
    const sqls = buildImportSql(target, "s3://b/orders/*.parquet", "parquet", true);
    expect(sqls).to.have.length(2);
    expect(sqls[0]).equals(`DROP TABLE IF EXISTS pg."analytics"."orders"`);
    expect(sqls[1]).equals(
      `CREATE TABLE pg."analytics"."orders" AS SELECT * FROM read_parquet('s3://b/orders/*.parquet')`
    );
  });

  test("append import (overwrite:false) inserts into the existing table", () => {
    const target = sqlanvil.Target.create({ schema: "analytics", name: "orders" });
    const sqls = buildImportSql(target, "local:///tmp/o.csv", "csv", false);
    expect(sqls).to.have.length(1);
    // local:// is stripped to a filesystem path for the reader.
    expect(sqls[0]).equals(
      `INSERT INTO pg."analytics"."orders" SELECT * FROM read_csv_auto('/tmp/o.csv')`
    );
  });

  test("import ATTACHes the postgres DSN read-write (no READ_ONLY)", () => {
    const sql = buildAttachSql(
      { host: "h", port: 5432, database: "d", user: "u", password: "p" },
      { readOnly: false }
    );
    expect(sql).contains("host=h port=5432 dbname=d user=u password=p");
    expect(sql).contains("AS pg (TYPE postgres)");
    expect(sql).not.contains("READ_ONLY");
  });
});
