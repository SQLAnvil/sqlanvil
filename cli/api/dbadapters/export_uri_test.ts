import { expect } from "chai";

import { extensionForFormat, resolveExportUri } from "sa/cli/api/dbadapters/export_uri";
import { suite, test } from "sa/testing";

suite("resolveExportUri", () => {
  test("DuckDB single-file uri uses filename then action name", () => {
    expect(
      resolveExportUri({ location: "s3://b/orders/", format: "parquet" }, "orders", {
        wildcard: false
      })
    ).equals("s3://b/orders/orders.parquet");
    expect(
      resolveExportUri({ location: "s3://b/orders", format: "csv", filename: "out" }, "orders", {
        wildcard: false
      })
    ).equals("s3://b/orders/out.csv");
  });

  test("BigQuery uri injects required _* before extension", () => {
    expect(
      resolveExportUri({ location: "gs://b/orders/", format: "parquet" }, "orders", {
        wildcard: true
      })
    ).equals("gs://b/orders/orders_*.parquet");
  });

  test("json maps to .jsonl", () => {
    expect(
      resolveExportUri({ location: "local://tmp/", format: "json" }, "x", { wildcard: false })
    ).equals("local://tmp/x.jsonl");
  });

  test("extensionForFormat", () => {
    expect(extensionForFormat("parquet")).equals(".parquet");
    expect(extensionForFormat("csv")).equals(".csv");
    expect(extensionForFormat("json")).equals(".jsonl");
  });
});
