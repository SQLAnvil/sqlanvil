import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import { mapBigQueryType, mapPostgresType, renderDeclarationSqlx, resolveConnection } from "sa/cli/api/commands/introspect";

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

suite("introspect codegen", () => {
  test("renders a declaration with columnTypes and descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "bq",
      schema: "geo_us_boundaries",
      name: "zip_codes",
      columns: [
        { name: "zip_code", type: "text", description: "5-digit ZIP" },
        { name: "internal_point_lat", type: "float8" }
      ]
    });
    expect(out).equals(
      `config {
  type: "declaration",
  connection: "bq",
  schema: "geo_us_boundaries",
  name: "zip_codes",
  columnTypes: {
    zip_code: "text",
    internal_point_lat: "float8"
  },
  columns: {
    zip_code: "5-digit ZIP"
  }
}
`
    );
  });

  test("omits the columns block when there are no descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "bq",
      name: "t",
      columns: [{ name: "id", type: "bigint" }]
    });
    expect(out).equals(
      `config {
  type: "declaration",
  connection: "bq",
  name: "t",
  columnTypes: {
    id: "bigint"
  }
}
`
    );
    expect(out).not.to.match(/columns:/);
  });

  test("quotes non-identifier column names and escapes quotes in descriptions", () => {
    const out = renderDeclarationSqlx({
      connection: "c",
      name: "t",
      columns: [{ name: "weird-name", type: "text", description: `has "quote"` }]
    });
    expect(out).to.contain(`"weird-name": "text"`);
    expect(out).to.contain(`"weird-name": "has \\"quote\\""`);
  });
});

suite("introspect connection resolution", ({ afterEach }) => {
  const tmp = new TmpDirFixture(afterEach);

  test("resolves a connection's definition and credentials", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres\n    host: db.example.com\n    port: 5432\n    database: legacy`
    );
    fs.writeFileSync(
      path.join(dir, ".df-credentials.json"),
      JSON.stringify({ wh: { password: "x" }, legacy: { user: "u", password: "p" } })
    );
    const resolved = resolveConnection(dir, "legacy");
    expect(resolved.definition.platform).equals("postgres");
    expect(resolved.definition.host).equals("db.example.com");
    expect(resolved.credentials.user).equals("u");
    expect(resolved.credentials.password).equals("p");
  });

  test("errors on unknown connection", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ wh: {} }));
    expect(() => resolveConnection(dir, "nope")).to.throw(/Unknown connection "nope"/);
  });

  test("errors when credentials for the connection are missing", () => {
    const dir = tmp.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  legacy:\n    platform: postgres`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ wh: {} }));
    expect(() => resolveConnection(dir, "legacy")).to.throw(/No credentials for connection "legacy"/);
  });
});
