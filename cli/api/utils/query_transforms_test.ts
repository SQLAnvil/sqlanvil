import { expect } from "chai";

import { setsDatasetId, wrapWithCreateSchemaIfNotExists } from "sa/cli/api/utils/query_transforms";
import { suite, test } from "sa/testing";

suite("setsDatasetId", () => {
  test("detects SET @@dataset_id statements", () => {
    expect(setsDatasetId("SET @@dataset_id = 'my_ds'")).equals(true);
    expect(setsDatasetId('set @@DATASET_ID="my_ds";\nSELECT * FROM t')).equals(true);
    expect(setsDatasetId("DECLARE x INT64;\nSET\n  @@dataset_id = 'my_ds';")).equals(true);
    expect(setsDatasetId("SET /* comment */ @@dataset_id = 'my_ds'")).equals(true);
    expect(setsDatasetId("SET -- comment\n@@dataset_id = 'my_ds'")).equals(true);
    expect(setsDatasetId("SET (@@dataset_project_id, @@dataset_id) = ('proj', 'my_ds')")).equals(
      true,
    );
  });

  test("ignores SET @@dataset_id inside comments, string literals, and quoted identifiers", () => {
    expect(setsDatasetId("SELECT 1 -- SET @@dataset_id = 'my_ds'")).equals(false);
    expect(setsDatasetId("SELECT 1 # SET @@dataset_id = 'my_ds'")).equals(false);
    expect(setsDatasetId("/* SET @@dataset_id = 'my_ds' */\nSELECT 1")).equals(false);
    expect(setsDatasetId("SELECT 'SET @@dataset_id = \"my_ds\"'")).equals(false);
    expect(setsDatasetId("SELECT \"SET @@dataset_id = 'my_ds'\"")).equals(false);
    expect(setsDatasetId("SELECT '''\nSET @@dataset_id = 'my_ds'\n'''")).equals(false);
    expect(setsDatasetId("SELECT r'\\' -- not a comment\n, 'SET @@dataset_id = \"my_ds\"'")).equals(
      false,
    );
    expect(setsDatasetId("SELECT * FROM `SET @@dataset_id = 'my_ds'`")).equals(false);
  });

  test("ignores reading @@dataset_id or setting other variables", () => {
    expect(setsDatasetId("SELECT @@dataset_id")).equals(false);
    expect(setsDatasetId("SET x = @@dataset_id")).equals(false);
    expect(setsDatasetId("SET (x, y) = (@@dataset_id, 1)")).equals(false);
    expect(setsDatasetId("SET @@dataset_project_id = 'proj'")).equals(false);
    expect(setsDatasetId("SET @@dataset_id_other = 'my_ds'")).equals(false);
  });
});

suite("wrapWithCreateSchemaIfNotExists", () => {
  test("wraps a statement in a block after creating the schema", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT 1;")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 1;\nend;",
    );
  });

  test("adds a missing semicolon", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "  SELECT 1\n")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 1;\nend;",
    );
  });

  test("terminates a statement with a trailing comment", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT 1 -- comment")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 1; -- comment\nend;",
    );
  });

  test("terminates a statement with a trailing # comment", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT 1 # comment")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 1; # comment\nend;",
    );
  });

  test("terminates a statement with a trailing block comment", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT 1 /* a; */")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 1; /* a; */\nend;",
    );
  });

  test("doesn't mistake a semicolon or comment marker inside a string for code", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT 'a; -- b'")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT 'a; -- b';\nend;",
    );
  });

  test("terminates a raw string ending in a backslash before a trailing comment", () => {
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", "SELECT r'\\' -- comment")).equals(
      "create schema if not exists `project.dataset`;\nbegin\nSELECT r'\\'; -- comment\nend;",
    );
  });

  test("keeps leading DECLARE statements at the start of the block", () => {
    expect(
      wrapWithCreateSchemaIfNotExists("project", "dataset", "DECLARE x INT64;\nSELECT x"),
    ).equals(
      "create schema if not exists `project.dataset`;\nbegin\nDECLARE x INT64;\nSELECT x;\nend;",
    );
  });

  test("doesn't add a semicolon after a terminated script", () => {
    const script = "BEGIN\n  SELECT 1;\nEXCEPTION WHEN ERROR THEN\n  RAISE;\nEND;";
    expect(wrapWithCreateSchemaIfNotExists("project", "dataset", script)).equals(
      `create schema if not exists \`project.dataset\`;\nbegin\n${script}\nend;`,
    );
  });

  test("omits the database if not set", () => {
    expect(wrapWithCreateSchemaIfNotExists(undefined, "dataset", "SELECT 1;")).equals(
      "create schema if not exists `dataset`;\nbegin\nSELECT 1;\nend;",
    );
  });
});
