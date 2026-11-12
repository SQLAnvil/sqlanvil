import { expect } from "chai";

import { setsDatasetId } from "sa/cli/api/utils/query_transforms";
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
