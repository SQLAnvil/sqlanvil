import { expect } from "chai";

import {
  buildAttachSql,
  buildCopySql,
  buildSecretSql,
  schemeOf
} from "sa/cli/api/dbadapters/duckdb_export";
import { suite, test } from "sa/testing";

suite("duckdb_export builders", () => {
  test("COPY wraps the SELECT in postgres_query and targets the uri", () => {
    const sql = buildCopySql("SELECT 1 AS id", "s3://b/orders/orders.parquet", "parquet", {});
    expect(sql).contains("postgres_query('pg', $sa$SELECT 1 AS id$sa$)");
    expect(sql).contains("TO 's3://b/orders/orders.parquet'");
    expect(sql).contains("(FORMAT parquet");
  });

  test("local:// maps to a filesystem path and appends options", () => {
    const sql = buildCopySql("SELECT 1", "local:///tmp/x.csv", "csv", { HEADER: "true" });
    expect(sql).contains("TO '/tmp/x.csv'");
    expect(sql).contains("FORMAT csv, HEADER true");
  });

  test("S3 secret carries endpoint + keys + path-style for Supabase Storage", () => {
    const s = buildSecretSql("s3", {
      endpoint: "ref.supabase.co/storage/v1/s3",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      region: "us-east-1"
    });
    expect(s).contains("CREATE OR REPLACE SECRET sa_export");
    expect(s).contains("TYPE s3");
    expect(s).contains("KEY_ID 'AK'");
    expect(s).contains("ENDPOINT 'ref.supabase.co/storage/v1/s3'");
    expect(s).contains("URL_STYLE 'path'");
  });

  test("local scheme has no secret", () => {
    expect(buildSecretSql("local", {})).equals(null);
  });

  test("ATTACH builds a read-only postgres DSN", () => {
    const sql = buildAttachSql({ host: "h", port: 5432, database: "d", user: "u", password: "p" });
    expect(sql).contains("host=h port=5432 dbname=d user=u password=p");
    expect(sql).contains("AS pg (TYPE postgres, READ_ONLY)");
  });

  test("schemeOf classifies uris", () => {
    expect(schemeOf("s3://b/x")).equals("s3");
    expect(schemeOf("gs://b/x")).equals("gcs");
    expect(schemeOf("local:///tmp/x")).equals("local");
    expect(schemeOf("/tmp/x")).equals("local");
  });
});
