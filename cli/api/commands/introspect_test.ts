import { expect } from "chai";

import { suite, test } from "sa/testing";
import { mapBigQueryType, mapPostgresType } from "sa/cli/api/commands/introspect";

suite("introspect type mapping", () => {
  test("maps common BigQuery types to Postgres types", () => {
    expect(mapBigQueryType("STRING")).equals("text");
    expect(mapBigQueryType("INT64")).equals("bigint");
    expect(mapBigQueryType("INTEGER")).equals("bigint");
    expect(mapBigQueryType("FLOAT64")).equals("float8");
    expect(mapBigQueryType("NUMERIC")).equals("numeric");
    expect(mapBigQueryType("BOOL")).equals("boolean");
    expect(mapBigQueryType("TIMESTAMP")).equals("timestamptz");
    expect(mapBigQueryType("DATE")).equals("date");
    expect(mapBigQueryType("BYTES")).equals("bytea");
    expect(mapBigQueryType("JSON")).equals("jsonb");
    expect(mapBigQueryType("GEOGRAPHY")).equals("text");
  });

  test("BigQuery mapping is case-insensitive", () => {
    expect(mapBigQueryType("string")).equals("text");
  });

  test("unmapped BigQuery type throws with the type name", () => {
    expect(() => mapBigQueryType("STRUCT")).to.throw(/Unmapped BigQuery type "STRUCT"/);
  });

  test("Postgres types pass through unchanged (lowercased/trimmed)", () => {
    expect(mapPostgresType("text")).equals("text");
    expect(mapPostgresType("  BIGINT ")).equals("bigint");
    expect(mapPostgresType("double precision")).equals("double precision");
  });
});
