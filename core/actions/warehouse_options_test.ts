import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";
import { coreExecutionRequestFromPath, runMainInVm } from "sa/testing/run_core";

// Enum fields in the postgres: / mysql: / supabase: blocks are written as names in sqlx
// configs. protobufjs create() keeps a name as a plain string, which the graph encode the
// runner receives turns into 0, so every name must be converted at compile time.
suite("warehouse option enums", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);
  const Method = sqlanvil.PostgresOptions.Index.Method;
  const PgKind = sqlanvil.PostgresOptions.Partition.Kind;
  const MyKind = sqlanvil.MysqlOptions.Partition.Kind;

  function compile(warehouse: string, files: { [file: string]: string }) {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      `defaultProject: db\ndefaultDataset: ds\nwarehouse: ${warehouse}`,
    );
    fs.mkdirSync(path.join(projectDir, "definitions"));
    Object.entries(files).forEach(([file, contents]) =>
      fs.writeFileSync(path.join(projectDir, "definitions", file), contents),
    );
    const graph = runMainInVm(coreExecutionRequestFromPath(projectDir)).compile.compiledGraph;
    // What the runner sees: the graph after a binary round trip.
    const decoded = sqlanvil.CompiledGraph.decode(sqlanvil.CompiledGraph.encode(graph).finish());
    return {
      errors: graph.graphErrors.compilationErrors.map((e) => e.message),
      table: (name: string) => decoded.tables.find((t) => t.target.name === name),
    };
  }

  [
    { given: `"gin"`, expected: Method.GIN },
    { given: `"GIN"`, expected: Method.GIN },
    { given: `"Brin"`, expected: Method.BRIN },
    { given: `3`, expected: Method.GIST },
    { given: `undefined`, expected: Method.BTREE },
  ].forEach(({ given, expected }) => {
    test(`postgres index method ${given} compiles to ${Method[expected]}`, () => {
      const method = given === "undefined" ? "" : `, method: ${given}`;
      const { errors, table } = compile("postgres", {
        "t.sqlx": `config { type: "table", postgres: { indexes: [{ columns: ["id"]${method} }] } }\nSELECT 1 AS id`,
        "inc.sqlx": `config { type: "incremental", postgres: { indexes: [{ columns: ["id"]${method} }] } }\nSELECT 1 AS id`,
        "mv.sqlx": `config { type: "view", materialized: true, postgres: { indexes: [{ columns: ["id"]${method} }] } }\nSELECT 1 AS id`,
      });
      expect(errors).deep.equals([]);
      ["t", "inc", "mv"].forEach((name) =>
        expect(table(name).postgres.indexes[0].method, name).equals(expected),
      );
    });
  });

  test("postgres partition kinds compile, including sub-partitions", () => {
    const { errors, table } = compile("postgres", {
      "t.sqlx": `
config {
  type: "table",
  postgres: {
    partition: {
      kind: "list",
      columns: ["region"],
      partitions: [{ name: "p_eu", values: "'eu'", subPartition: { kind: "Hash", columns: ["id"] } }]
    }
  }
}
SELECT 1 AS id, 'eu' AS region`,
    });
    expect(errors).deep.equals([]);
    const partition = table("t").postgres.partition;
    expect(partition.kind).equals(PgKind.LIST);
    expect(partition.partitions[0].subPartition.kind).equals(PgKind.HASH);
  });

  test("mysql partition kinds compile", () => {
    const { errors, table } = compile("mysql", {
      "h.sqlx": `config { type: "table", mysql: { partition: { kind: "hash", expression: "id", count: 4 } } }\nSELECT 1 AS id`,
      "k.sqlx": `config { type: "incremental", mysql: { partition: { kind: "KEY", expression: "id", count: 4 } } }\nSELECT 1 AS id`,
    });
    expect(errors).deep.equals([]);
    expect(table("h").mysql.partition.kind).equals(MyKind.HASH);
    expect(table("k").mysql.partition.kind).equals(MyKind.KEY);
  });

  test("postgres options nested under supabase compile their enums too", () => {
    const { errors, table } = compile("supabase", {
      "t.sqlx": `config { type: "table", supabase: { postgres: { indexes: [{ columns: ["id"], method: "gin" }] } } }\nSELECT 1 AS id`,
    });
    expect(errors).deep.equals([]);
    expect(table("t").supabase.postgres.indexes[0].method).equals(Method.GIN);
  });

  [
    {
      warehouse: "postgres",
      config: `postgres: { indexes: [{ columns: ["id"], method: "fulltext" }] }`,
      error: /Unknown postgres index method "fulltext"; use one of: btree, hash, gin, gist, brin\./,
    },
    {
      warehouse: "postgres",
      config: `postgres: { partition: { kind: "interval", columns: ["id"] } }`,
      error: /Unknown postgres partition kind "interval"; use one of: range, list, hash\./,
    },
    {
      warehouse: "mysql",
      config: `mysql: { partition: { kind: "columns", expression: "id" } }`,
      error: /Unknown mysql partition kind "columns"; use one of: range, list, hash, key\./,
    },
    {
      warehouse: "postgres",
      config: `postgres: { indexes: [{ columns: ["id"], method: 9 }] }`,
      error: /Unknown postgres index method "9"/,
    },
  ].forEach(({ warehouse, config, error }) => {
    test(`an unknown value is a compile error: ${config}`, () => {
      const { errors } = compile(warehouse, {
        "t.sqlx": `config { type: "table", ${config} }\nSELECT 1 AS id`,
      });
      expect(errors.join("\n")).to.match(error);
    });
  });
});
