// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as path from "path";

import { readViaDuckdb, writeViaDuckdb } from "sa/cli/api/dbadapters/duckdb_export";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

// Proves the DuckDB native binding loads + writes/reads files in the build/test
// environment (packaging validation). The full Postgres → file flow is covered by
// the Postgres integration spec.
suite("duckdb export integration", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("writes + reads back a local parquet file", { timeout: 60000 }, async () => {
    const dir = tmpDirFixture.createNewTmpDir();
    const uri = `local://${path.join(dir, "out.parquet")}`;
    await writeViaDuckdb("SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'", uri, "parquet");
    const rows = (await readViaDuckdb(uri, "parquet"))
      .map((r: any) => ({ id: Number(r.id), name: r.name }))
      .sort((a, b) => a.id - b.id);
    expect(rows).deep.equals([
      { id: 1, name: "a" },
      { id: 2, name: "b" }
    ]);
  });

  test("writes csv", { timeout: 60000 }, async () => {
    const dir = tmpDirFixture.createNewTmpDir();
    const uri = `local://${path.join(dir, "out.csv")}`;
    await writeViaDuckdb("SELECT 1 AS id", uri, "csv");
    const rows = await readViaDuckdb(uri, "csv");
    expect(Number(rows[0].id)).equals(1);
  });
});
