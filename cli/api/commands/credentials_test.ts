// tslint:disable tsr-detect-non-literal-fs-filename
import { expect } from "chai";
import * as fs from "fs-extra";
import * as path from "path";

import { read, readStorageCredentials, writeFile } from "sa/cli/api/commands/credentials";
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
        storage: { s3: { endpoint: "e", accessKeyId: "k", secretAccessKey: "s" } },
      }),
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

// Upstream #2454: the credentials file is written with owner-only permissions, atomically.
suite("writeFile", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);
  const contents = `${JSON.stringify({ projectId: "my-gcp-project", location: "US" }, null, 2)}\n`;

  test("creates a credentials file that read parses back", () => {
    const credentialsPath = path.join(tmpDirFixture.createNewTmpDir(), ".df-credentials.json");

    writeFile(credentialsPath, contents);

    expect(fs.readFileSync(credentialsPath, "utf8")).to.equal(contents);
    expect(read(credentialsPath).projectId).to.equal("my-gcp-project");
  });

  test("replaces the contents of an existing credentials file", () => {
    const credentialsPath = path.join(tmpDirFixture.createNewTmpDir(), ".df-credentials.json");
    fs.writeFileSync(credentialsPath, JSON.stringify({ projectId: "old", credentials: "old-key" }));

    writeFile(credentialsPath, contents);

    expect(fs.readFileSync(credentialsPath, "utf8")).to.equal(contents);
  });

  test("leaves only the credentials file in its directory", () => {
    const directory = tmpDirFixture.createNewTmpDir();

    writeFile(path.join(directory, ".df-credentials.json"), contents);

    expect(fs.readdirSync(directory)).to.deep.equal([".df-credentials.json"]);
  });

  test("removes its temporary file when it cannot replace the target", () => {
    const directory = tmpDirFixture.createNewTmpDir();
    const credentialsPath = path.join(directory, ".df-credentials.json");
    // A file can't be renamed over a directory.
    fs.mkdirSync(credentialsPath);

    expect(() => writeFile(credentialsPath, contents)).to.throw();

    expect(fs.readdirSync(directory)).to.deep.equal([".df-credentials.json"]);
    expect(fs.statSync(credentialsPath).isDirectory()).to.equal(true);
  });

  // Permission bits are POSIX-only.
  if (process.platform !== "win32") {
    const permissionBits = (filePath: string) => fs.statSync(filePath).mode & 0o777;

    test("creates the credentials file with owner-only permissions", () => {
      const credentialsPath = path.join(tmpDirFixture.createNewTmpDir(), ".df-credentials.json");

      writeFile(credentialsPath, contents);

      expect(permissionBits(credentialsPath)).to.equal(0o600);
    });

    test("restricts an existing credentials file to its owner", () => {
      const credentialsPath = path.join(tmpDirFixture.createNewTmpDir(), ".df-credentials.json");
      fs.writeFileSync(credentialsPath, "{}");
      // Set explicitly, so that the starting permissions don't depend on the umask.
      fs.chmodSync(credentialsPath, 0o644);

      writeFile(credentialsPath, contents);

      expect(permissionBits(credentialsPath)).to.equal(0o600);
    });

    test("replaces a symbolic link instead of writing through it", () => {
      const directory = tmpDirFixture.createNewTmpDir();
      const linkTargetPath = path.join(directory, "shared.json");
      const credentialsPath = path.join(directory, ".df-credentials.json");
      fs.writeFileSync(linkTargetPath, "{}");
      fs.symlinkSync(linkTargetPath, credentialsPath);

      writeFile(credentialsPath, contents);

      expect(fs.lstatSync(credentialsPath).isSymbolicLink()).to.equal(false);
      expect(fs.readFileSync(linkTargetPath, "utf8")).to.equal("{}");
      expect(read(credentialsPath).projectId).to.equal("my-gcp-project");
    });
  }
});
