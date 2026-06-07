import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import { mapBigQueryType, mapPostgresType, renderDeclarationSqlx, resolveConnection, introspectToSqlx } from "sa/cli/api/commands/introspect";
import { read as readCredentials, readConnections } from "sa/cli/api/commands/credentials";

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
      JSON.stringify({ connections: { wh: { password: "x" }, legacy: { user: "u", password: "p" } } })
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

suite("introspect orchestrator", ({ afterEach }) => {
  const tmp2 = new TmpDirFixture(afterEach);

  test("rejects when no source schema can be resolved", () => {
    const dir = tmp2.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bare:\n    platform: postgres\n    host: h`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ connections: { wh: {}, bare: { user: "u" } } }));
    const reader = function() { return Promise.resolve([]); };
    return introspectToSqlx(dir, "bare", "orders", { reader: reader }).then(
      function() { throw new Error("expected rejection"); },
      function(e) { expect(e.message).to.match(/Could not determine the source schema/); }
    );
  });

  test("rejects when the source table has no columns", () => {
    const dir = tmp2.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: p\n    dataset: d\n    saKeyId: v`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ connections: { wh: {}, bq: { credentials: "{}" } } }));
    const empty = function() { return Promise.resolve([]); };
    return introspectToSqlx(dir, "bq", "d.t", { reader: empty }).then(
      function() { throw new Error("expected rejection"); },
      function(e) { expect(e.message).to.match(/no columns/); }
    );
  });

  test("maps source columns and renders sqlx via an injected reader", async () => {
    const dir = tmp2.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: wh\nconnections:\n  wh:\n    platform: supabase\n  bq:\n    platform: bigquery\n    project: bigquery-public-data\n    dataset: geo_us_boundaries\n    saKeyId: vault-1`
    );
    fs.writeFileSync(path.join(dir, ".df-credentials.json"), JSON.stringify({ connections: { wh: {}, bq: { credentials: "{}" } } }));

    const fakeReader = function() {
      return Promise.resolve([
        { name: "zip_code", type: "STRING", description: "5-digit ZIP" },
        { name: "internal_point_lat", type: "FLOAT64" }
      ]);
    };
    const sqlx = await introspectToSqlx(dir, "bq", "geo_us_boundaries.zip_codes", { reader: fakeReader });
    expect(sqlx).to.contain(`connection: "bq"`);
    expect(sqlx).to.contain(`zip_code: "text"`);
    expect(sqlx).to.contain(`internal_point_lat: "float8"`);
    expect(sqlx).to.contain(`zip_code: "5-digit ZIP"`);
  });
});

suite("credentials coexistence: run + introspect share one .df-credentials.json", ({ afterEach }) => {
  const tmp3 = new TmpDirFixture(afterEach);

  test("flat warehouse creds + connections map: run reads warehouse, introspect reads source", () => {
    const dir = tmp3.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      `defaultDataset: public\nwarehouse: supabase\nconnections:\n  bq:\n    platform: bigquery\n    project: p\n    dataset: d\n    saKeyId: v`
    );
    const credsPath = path.join(dir, ".df-credentials.json");
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        host: "db.example.com",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: "pw",
        sslMode: "require",
        defaultSchema: "public",
        // Read-only source-connection creds for `introspect`, alongside the warehouse creds.
        connections: { bq: { credentials: "{}" } }
      })
    );
    // `run` path: the warehouse credentials validate — the `connections` map must NOT
    // trip the strict "Unexpected property" check.
    const warehouse = readCredentials(credsPath, "supabase");
    expect(warehouse.host).equals("db.example.com");
    // `introspect` path: the source credentials resolve from `connections.<name>`.
    const resolved = resolveConnection(dir, "bq");
    expect(resolved.credentials.credentials).equals("{}");
  });

  test("readConnections returns the connections map, or {} when absent", () => {
    const dir = tmp3.createNewTmpDir();
    const credsPath = path.join(dir, ".df-credentials.json");
    // No file → {}
    expect(readConnections(credsPath)).to.deep.equal({});
    // Flat warehouse creds, no connections key → {}
    fs.writeFileSync(credsPath, JSON.stringify({ host: "h", user: "u", password: "p" }));
    expect(readConnections(credsPath)).to.deep.equal({});
    // With a connections map → returned verbatim
    fs.writeFileSync(
      credsPath,
      JSON.stringify({ host: "h", connections: { pg_src: { user: "ro", password: "secret" } } })
    );
    expect(readConnections(credsPath)).to.deep.equal({ pg_src: { user: "ro", password: "secret" } });
  });
});
