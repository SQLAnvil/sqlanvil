// FR-041 AC-041.4 (test-cases/release.yaml T-041.4).

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

/**
 * Adds an @hidden tag to the doc comment of `export class Notebook` in the given file, keeping the
 * file (so the code still compiles). When the class has a doc comment, the tag goes on its own line
 * before the comment's closing; when it has none, a doc comment holding only the tag is put in
 * front of the declaration.
 */
function hideNotebookClass(file: string) {
  const text = fs.readFileSync(file, "utf8");
  const decl = /^([ \t]*)export class Notebook\b/gm;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(text)) !== null) {
    matches.push(m);
  }
  if (matches.length !== 1) {
    throw new Error(`expected one 'export class Notebook' in ${file}, found ${matches.length}`);
  }
  const at = matches[0].index;
  const indent = matches[0][1];
  const before = text.substring(0, at);
  const trimmed = before.replace(/\s+$/, "");
  let out: string;
  if (trimmed.endsWith("*/")) {
    const open = trimmed.lastIndexOf("/*");
    if (open >= 0 && trimmed.substring(open, open + 3) === "/**") {
      const close = trimmed.length - 2;
      out =
        trimmed.substring(0, close).replace(/[ \t]*$/, "") +
        `\n${indent} * @hidden\n${indent} */` +
        before.substring(trimmed.length) +
        text.substring(at);
    } else {
      out = before + `${indent}/** @hidden */\n` + text.substring(at);
    }
  } else {
    out = before + `${indent}/** @hidden */\n` + text.substring(at);
  }
  fs.writeFileSync(file, out);
}

suite("release regenerate_docs missing page", () => {
  test(
    "@prd T-041.4 a class page typedoc does not emit is skipped with a warning",
    { timeout: DOCS_TIMEOUT_MILLIS },
    async () => {
      await withTemp(async (T) => {
        const docs = makeDocsRepo(T);
        const notebookTs = path.join(docs.repo, "core", "actions", "notebook.ts");
        hideNotebookClass(notebookTs);
        expect(fs.existsSync(notebookTs), "core/actions/notebook.ts is kept").equals(true);
        const notebook = path.join(docs.reference, "notebook.md");
        writeFile(notebook, "KEEP\n");
        const r = await regenerate(docs);
        expect(r.stdout, r.stderr).to.include(
          "WARNING: typedoc did not emit _core_actions_notebook_.notebook.md — skipping notebook",
        );
        expect(
          fileLines(fs.readFileSync(notebook, "utf8")),
          "notebook.md still holds the line 'KEEP'",
        ).deep.equals(["KEEP"]);
        const table = path.join(docs.reference, "table.md");
        expect(fs.existsSync(table), "table.md exists").equals(true);
        expect(fs.statSync(table).size, "table.md is non-empty").to.be.greaterThan(0);
      });
    },
  );
});
