// FR-041 AC-041.3 (test-cases/release.yaml T-041.3).

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import {
  DOCS_TIMEOUT_MILLIS,
  fileLines,
  makeDocsRepo,
  regenerate,
  withTemp,
  writeFile,
} from "./docs_helpers";

suite("release regenerate_docs no front matter", () => {
  test(
    "@prd T-041.3 a page without front matter, or absent, is replaced whole",
    { timeout: DOCS_TIMEOUT_MILLIS },
    async () => {
      await withTemp(async (T) => {
        const docs = makeDocsRepo(T);
        const session = path.join(docs.reference, "session.md");
        const view = path.join(docs.reference, "view.md");
        writeFile(session, "OLD SESSION\n");
        expect(fs.existsSync(view), "view.md is absent before").equals(false);
        const r = await regenerate(docs);
        expect(r.exitCode, r.stderr).equals(0);
        const sessionText = fs.readFileSync(session, "utf8");
        expect(sessionText, "session.md does not contain 'OLD SESSION'").not.to.include(
          "OLD SESSION",
        );
        expect(fileLines(sessionText)[0], "session.md first line").not.equals("---");
        expect(fs.existsSync(view), "view.md exists").equals(true);
        expect(fileLines(fs.readFileSync(view, "utf8"))[0], "view.md first line").not.equals("---");
      });
    },
  );
});
