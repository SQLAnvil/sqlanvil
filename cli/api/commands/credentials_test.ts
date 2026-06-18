// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { readStorageCredentials } from "sa/cli/api/commands/credentials";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

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
