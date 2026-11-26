// Release area: the sample extension's extension() (FR-035 AC-035.1 to AC-035.3;
// test-cases/release.yaml T-035.1 to T-035.3). The extension is loaded from the bundle of
// SAMPLE_TAR (its manifest's main), and compiled into a sa/core/session Session.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import { runfile, withTemp } from "./helpers";
import { extractTarGz, readTarGz, SAMPLE_TAR } from "./tar";

/**
 * sa/core/session's Session. The core entry module is loaded first so the core modules load in
 * the order the package itself loads them (loaded alone, session.ts meets a circular import).
 */
function loadSession(): any {
  try {
    require("sa/core");
  } catch (e) {
    // Only the load order is wanted from it; sa/core/session below is the module under test.
  }
  const m = require("sa/core/session");
  return m.Session || m.default;
}

const Session: any = loadSession();

/**
 * Calls `fn` with the sample extension's `extension` (from the bundle of SAMPLE_TAR, extracted
 * into a directory of its own) and T, the case's new empty temporary directory (an absolute path).
 */
async function withExtension(fn: (extension: () => any, T: string) => Promise<void>) {
  await withTemp(async (X) => {
    extractTarGz(runfile(SAMPLE_TAR), X);
    const mod = require(path.join(X, "package", "bundle.js"));
    await withTemp(async (T) => {
      await fn(mod.extension, T);
    });
  }, "prd-release-sample-");
}

/**
 * T-035.1 and T-035.3: T is the case's new empty temporary directory (an absolute path); SAMPLE_TAR's
 * package/ is extracted into T/ext (each regular-file entry `package/<rest>` written to
 * T/ext/<rest>), and `fn` gets the `extension` of T/ext/bundle.js and T.
 */
async function withExtensionInT(fn: (extension: () => any, T: string) => Promise<void>) {
  await withTemp(async (T) => {
    const ext = path.join(T, "ext");
    for (const e of readTarGz(runfile(SAMPLE_TAR))) {
      if (e.type !== "0" || e.name.endsWith("/") || !e.name.startsWith("package/")) {
        continue;
      }
      const out = path.join(ext, e.name.substring("package/".length));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, e.data);
    }
    const mod = require(path.join(ext, "bundle.js"));
    await fn(mod.extension, path.resolve(T));
  }, "prd-release-sample-");
}

function request(vars: { [key: string]: string }): any {
  return { compileConfig: { projectConfigOverride: { vars } } };
}

suite("release sample extension", () => {
  test("@prd T-035.1 with neither var set, the extension publishes sample-action", async () => {
    await withExtensionInT(async (extension, T) => {
      const S: any = new Session(T);
      extension().compile(request({}), S);
      const G: any = S.compile();
      const tables: any[] = G.tables || [];
      expect(tables.map((t) => t.target.name), "G_table_target_names").deep.equals(["sample-action"]);
      expect(tables[0].query, "G_sample_action_query").equals("SELECT 1 as sample_id");
      expect(((G.graphErrors || {}).compilationErrors || []).length, "G_compilation_errors").equals(0);
    });
  });

  test("@prd T-035.2 throw-error makes the extension throw and publish nothing", async () => {
    await withExtension(async (extension) => {
      const S: any = new Session();
      let thrown: any;
      try {
        extension().compile(request({ "throw-error": "true" }), S);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, "throws").not.equals(undefined);
      expect(thrown && thrown.message !== undefined ? String(thrown.message) : String(thrown)).equals(
        "throwing exception as requested!",
      );
      const G: any = S.compile();
      expect((G.tables || []).length, "S_compile_table_count").equals(0);
    });
  });

  test("@prd T-035.3 store-compile-error records the error and still publishes sample-action", async () => {
    await withExtensionInT(async (extension, T) => {
      const S: any = new Session(T);
      extension().compile(request({ "store-compile-error": "true" }), S);
      const G: any = S.compile();
      const errors: any[] = (G.graphErrors || {}).compilationErrors || [];
      expect(errors.map((e) => e.message), "G_compilation_error_messages").deep.equals([
        "storing compilation error as requested!",
      ]);
      expect((G.tables || []).map((t: any) => t.target.name), "G_table_target_names").deep.equals(["sample-action"]);
    });
  });
});
