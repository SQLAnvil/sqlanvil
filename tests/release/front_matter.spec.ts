// FR-041 AC-041.2 (test-cases/release.yaml T-041.2).

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

suite("release regenerate_docs front matter", () => {
  test(
    "@prd T-041.2 a page's front matter is kept and the body replaced",
    { timeout: DOCS_TIMEOUT_MILLIS },
    async () => {
      await withTemp(async (T) => {
        const docs = makeDocsRepo(T);
        const table = path.join(docs.reference, "table.md");
        writeFile(table, ["---", 'title: "Table"', "---", "", "OLD BODY"].join("\n") + "\n");
        const r = await regenerate(docs);
        expect(r.exitCode, r.stderr).equals(0);
        const text = fs.readFileSync(table, "utf8");
        const lines = fileLines(text);
        expect(lines.slice(0, 3), "table.md lines 1 to 3").deep.equals([
          "---",
          'title: "Table"',
          "---",
        ]);
        expect(lines[3], "table.md line 4").equals("");
        expect(
          lines[4] !== undefined && lines[4] !== "",
          `table.md line 5 is non-empty: ${JSON.stringify(lines[4])}`,
        ).equals(true);
        expect(text, "table.md does not contain 'OLD BODY'").not.to.include("OLD BODY");
      });
    },
  );
});
