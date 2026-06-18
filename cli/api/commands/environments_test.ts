import { expect } from "chai";
import * as fs from "fs-extra";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import {
  mergeProjectConfigOverride,
  resolveCredentials,
  resolveEnvironment
} from "sa/cli/api/commands/environments";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("resolveEnvironment", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  function projectWith(environments: any): string {
    const dir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      dumpYaml({ warehouse: "postgres", defaultDataset: "analytics", environments })
    );
    return dir;
  }

  test("maps a defined environment to a config override + credentials", () => {
    const dir = projectWith({
      prod: {
        schemaSuffix: "prod",
        vars: { region: "us-prod" },
        defaultDatabase: "prod_db",
        credentials: ".df-credentials.prod.json"
      }
    });
    const { configOverride, credentials } = resolveEnvironment(dir, "prod");
    expect(configOverride.schemaSuffix).to.equal("prod");
    expect(configOverride.vars).to.deep.equal({ region: "us-prod" });
    expect(configOverride.defaultDatabase).to.equal("prod_db");
    expect(credentials).to.equal(".df-credentials.prod.json");
  });

  test("omits unset fields from the override", () => {
    const dir = projectWith({ dev: { schemaSuffix: "dev" } });
    const { configOverride, credentials } = resolveEnvironment(dir, "dev");
    expect(configOverride).to.deep.equal({ schemaSuffix: "dev" });
    expect(credentials).to.equal(undefined);
  });

  test("unknown environment throws with the available list", () => {
    const dir = projectWith({ dev: {}, prod: {} });
    expect(() => resolveEnvironment(dir, "staging")).to.throw(/not found.*dev, prod/i);
  });

  test("no environments block throws a clear error", () => {
    const dir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(dir, "workflow_settings.yaml"),
      dumpYaml({ warehouse: "postgres", defaultDataset: "analytics" })
    );
    expect(() => resolveEnvironment(dir, "dev")).to.throw(/no environments defined/i);
  });
});

suite("mergeProjectConfigOverride", () => {
  test("CLI override wins over env, vars merge per-key", () => {
    const merged = mergeProjectConfigOverride(
      { schemaSuffix: "dev", vars: { a: "1", b: "env" } },
      { schemaSuffix: "qa", vars: { b: "cli", c: "3" } }
    );
    expect(merged.schemaSuffix).to.equal("qa");
    expect(merged.vars).to.deep.equal({ a: "1", b: "cli", c: "3" });
  });

  test("no vars on either side leaves vars unset", () => {
    const merged = mergeProjectConfigOverride({ schemaSuffix: "dev" }, {});
    expect(merged.schemaSuffix).to.equal("dev");
    expect(merged.vars).to.equal(undefined);
  });
});

suite("resolveCredentials", () => {
  const DEFAULT = ".df-credentials.json";
  test("explicit non-default --credentials wins", () => {
    expect(resolveCredentials(".df-credentials.prod.json", "custom.json", DEFAULT)).to.equal(
      "custom.json"
    );
  });
  test("falls back to env credentials when --credentials is the default", () => {
    expect(resolveCredentials(".df-credentials.prod.json", DEFAULT, DEFAULT)).to.equal(
      ".df-credentials.prod.json"
    );
  });
  test("falls back to default when neither is set", () => {
    expect(resolveCredentials(undefined, DEFAULT, DEFAULT)).to.equal(DEFAULT);
  });
});
