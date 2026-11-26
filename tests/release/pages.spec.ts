// FR-041 AC-041.1 (test-cases/release.yaml T-041.1).

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import { DOCS_TIMEOUT_MILLIS, makeDocsRepo, PAGES, regenerate, withTemp } from "./docs_helpers";

suite("release regenerate_docs pages", () => {
  test(
    "@prd T-041.1 regenerate_docs writes the twelve reference pages",
    { timeout: DOCS_TIMEOUT_MILLIS },
    async () => {
      await withTemp(async (T) => {
        const docs = makeDocsRepo(T);
        const r = await regenerate(docs);
        expect(r.exitCode, r.stderr).equals(0);
        expect(r.stdout).to.include(`Generated JS-API reference pages into ${docs.reference}`);
        expect(r.stdout).to.include(`Generated configs.md into ${docs.reference}`);
        for (const page of PAGES) {
          const file = path.join(docs.reference, page);
          expect(fs.existsSync(file), `${page} exists`).equals(true);
          expect(fs.statSync(file).size, `${page} is non-empty`).to.be.greaterThan(0);
        }
      });
    },
  );
});
