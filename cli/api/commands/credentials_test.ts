// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { read, readStorageCredentials } from "sa/cli/api/commands/credentials";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("read (bigquery)", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  const write = (contents: object) => {
    const p = path.join(tmpDirFixture.createNewTmpDir(), ".df-credentials.json");
    fs.writeFileSync(p, JSON.stringify(contents));
    return p;
  };

  // The documented BigQuery shape, and what test_credentials/bigquery.json holds.
  test("accepts projectId + location + credentials", () => {
    const credentials = read(write({ projectId: "p", location: "US", credentials: "{}" }));
    expect(credentials.projectId).equals("p");
    expect(credentials.location).equals("US");
  });

  test("accepts a keyless accessToken", () => {
    expect(read(write({ projectId: "p", accessToken: "tok" })).accessToken).equals("tok");
  });

  test("still rejects an unknown property", () => {
    expect(() => read(write({ projectId: "p", nonsense: "x" }))).throws(/nonsense/);
  });
});

suite("readStorageCredentials", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  test("returns the storage section", () => {
    const dir = tmpDirFixture.createNewTmpDir();
    const p = path.join(dir, ".df-credentials.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        host: "h",
        storage: { s3: { endpoint: "e", accessKeyId: "k", secretAccessKey: "s" } }
      })
    );
    const storage = readStorageCredentials(p);
    expect(storage.s3.endpoint).equals("e");
  });

  test("returns undefined when no storage section", () => {
    const dir = tmpDirFixture.createNewTmpDir();
    const p = path.join(dir, ".df-credentials.json");
    fs.writeFileSync(p, JSON.stringify({ host: "h" }));
    expect(readStorageCredentials(p)).equals(undefined);
  });
});
