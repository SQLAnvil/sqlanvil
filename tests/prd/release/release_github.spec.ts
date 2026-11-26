// Release area: scripts/release_github (FR-036, FR-037, FR-038; test-cases/release.yaml
// T-036.1 to T-038.9). Every case sets WHATS_NEW=WN and TMPDIR=T/tmp unless it says otherwise.

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import { fileLines, withTemp, writeFile } from "./helpers";
import { KnownFailure, strictKnownFailure } from "./known_failing";
import {
  GhCall,
  ghCalls,
  git,
  makeRepo,
  runReleaseGithub,
  ScriptRepo,
  tagCommit,
  tagMessage,
  tags,
  tagType,
  WN_LINES,
  writeGhStub,
} from "./script_repo";

const TITLE = "Title   : v9.8.7 — Test headline with `code`";

function expectNoTagNoCall(repo: ScriptRepo) {
  expect(tags(repo, "R"), "R has no tag").deep.equals([]);
  expect(tags(repo, "origin"), "T/origin.git has no tag").deep.equals([]);
  expect(ghCalls(repo.T), "the gh stub records no call").deep.equals([]);
}

const NOTES_FILE = "a temporary file holding the release notes";

/**
 * The release notes of a WN section, as AC-036.6 builds them (T-036.6 gives 9.8.7's): the section
 * body, trailing empty lines removed, site links made absolute, an empty line and the install line.
 */
const RELEASE_NOTES: { [version: string]: string[] } = {
  "9.8.7": [
    "",
    "Intro line linking [guide](https://sqlanvil.com/docs/guide/).",
    "",
    "- item",
    "",
    "**Install:** `npm i -g @sqlanvil/cli@9.8.7`",
  ],
  "9.8.6": ["", "Old body.", "", "**Install:** `npm i -g @sqlanvil/cli@9.8.6`"],
};

/**
 * Checks a recorded gh call against an expected argv. The value NOTES_FILE matches an argument
 * naming a file that existed when gh was called (the stub copied it) and held `notes`.
 */
function expectCall(actual: GhCall, expected: string[], notes: string[], label: string) {
  const argv = actual.argv;
  expect(argv.length, `${label}: ${JSON.stringify(argv)}`).equals(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === NOTES_FILE) {
      expect(actual.notes, `${label}: argument ${i + 1} (${argv[i]}) names a file gh could read`).not.equals(undefined);
      expect(fileLines(actual.notes as string), `${label}: argument ${i + 1} (${argv[i]}) holds the release notes`).deep.equals(
        notes,
      );
    } else {
      expect(argv[i], `${label}: argument ${i + 1} of ${JSON.stringify(argv)}`).equals(expected[i]);
    }
  }
}

/** The value after `--notes-file` in a recorded argv, or undefined. */
function notesFileArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--notes-file");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** The commit a tag points at, or undefined when the tag does not exist. */
function tagCommitOrUndefined(repo: ScriptRepo, where: "R" | "origin", tag: string): string | undefined {
  return tags(repo, where).includes(tag) ? tagCommit(repo, where, tag) : undefined;
}

suite("release release_github", () => {
  test("@prd T-036.1 the version comes from VERSION when non-empty, else from version.bzl", async () => {
    await withTemp(async (T) => {
      const wn = [...WN_LINES];
      wn.splice(wn.indexOf("## 9.8.7 — Test headline with `code`"), 0, "## 1.2.3 — Override", "");
      const repo = makeRepo(T, { wnLines: wn });
      const tagLine = (stdout: string) => fileLines(stdout).filter((l) => l.startsWith("Tag"));

      const fromFile = await runReleaseGithub(repo, { DRY_RUN: "1", VERSION: undefined });
      expect(fileLines(fromFile.stdout)[0], `from_file: stdout_line_1 (${fromFile.stderr})`).equals("Version : 9.8.7");
      expect(tagLine(fromFile.stdout).length, "from_file: one Tag line").equals(1);
      expect(tagLine(fromFile.stdout)[0].startsWith("Tag     : v9.8.7  (commit "), `from_file: ${tagLine(fromFile.stdout)[0]}`).equals(true);

      const empty = await runReleaseGithub(repo, { DRY_RUN: "1", VERSION: "" });
      expect(fileLines(empty.stdout)[0], `empty: stdout_line_1 (${empty.stderr})`).equals("Version : 9.8.7");

      const override = await runReleaseGithub(repo, { DRY_RUN: "1", VERSION: "1.2.3" });
      expect(fileLines(override.stdout)[0], `override: stdout_line_1 (${override.stderr})`).equals("Version : 1.2.3");
      expect(tagLine(override.stdout).length, "override: one Tag line").equals(1);
      expect(tagLine(override.stdout)[0].startsWith("Tag     : v1.2.3  (commit "), `override: ${tagLine(override.stdout)[0]}`).equals(true);
    });
  });

  test("@prd T-036.2 with WHATS_NEW unset, the sibling sqlanvil-com whats-new is read", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeFile(
        path.join(T, "sqlanvil-com", "src", "content", "docs", "docs", "whats-new.md"),
        fs.readFileSync(repo.WN),
      );
      const r = await runReleaseGithub(repo, { DRY_RUN: "1", WHATS_NEW: undefined }, T);
      expect(r.exitCode, r.stderr).equals(0);
      expect(r.stdout).to.include(TITLE);
    });
  });

  test("@prd T-036.3 a missing whats-new file stops with its error and creates nothing", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [0] });
      const none = path.join(T, "none.md");
      const r = await runReleaseGithub(repo, { WHATS_NEW: none });
      expect(r.exitCode, "exit code").equals(1);
      expect(fileLines(r.stderr)).to.include(`whats-new not found: ${none} (set WHATS_NEW=...)`);
      expectNoTagNoCall(repo);
    });
  });

  test("@prd T-036.4 a version with no whats-new section stops with its error and creates nothing", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [0] });
      const r = await runReleaseGithub(repo, { VERSION: "9.9.9" });
      expect(r.exitCode, "exit code").equals(1);
      expect(fileLines(r.stderr)).to.include(`no '## 9.9.9' section in ${repo.WN} — add the release entry first`);
      expectNoTagNoCall(repo);
    });
  });

  test("@prd T-036.5 the release title is v<version> — <headline>", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      const r = await runReleaseGithub(repo, { DRY_RUN: "1" });
      expect(fileLines(r.stdout)[2], `stdout_line_3 (${r.stderr})`).equals(TITLE);
    });
  });

  test("@prd T-036.6 the release notes are the section body with site links and the install line", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [1] });
      const r = await runReleaseGithub(repo);
      const notes = ghCalls(T)
        .filter((c) => c.notes !== undefined)
        .map((c) => c.notes as string);
      expect(notes.length, `the gh stub recorded one notes file (exit ${r.exitCode}: ${r.stderr})`).equals(1);
      expect(fileLines(notes[0])).deep.equals([
        "",
        "Intro line linking [guide](https://sqlanvil.com/docs/guide/).",
        "",
        "- item",
        "",
        "**Install:** `npm i -g @sqlanvil/cli@9.8.7`",
      ]);
    });
  });

  test("@prd T-036.7 known-failing E-015 version.bzl with no SQLANVIL_VERSION stops with its error and creates nothing", async () => {
    await strictKnownFailure("E-015", async () => {
      await withTemp(async (T) => {
        const repo = makeRepo(T, { versionBzl: 'DF_VERSION = "3.1.8"\n' });
        writeGhStub(T, { view: [0] });
        const r = await runReleaseGithub(repo, { VERSION: undefined });
        // The symptom: release_github exits 1 and prints nothing on stderr.
        if (r.exitCode === 1 && r.stderr === "") {
          throw new KnownFailure("E-015", "release_github exits 1 and prints nothing on stderr");
        }
        expect(r.exitCode, "exit code").equals(1);
        expect(fileLines(r.stderr), "stderr_line").to.include("could not read SQLANVIL_VERSION from version.bzl");
        expectNoTagNoCall(repo);
      });
    });
  });

  test("@prd T-037.1 DRY_RUN=1 prints the version, tag, title and notes", async () => {
    await withTemp(async (T) => {
      const c1 = "release: SQLAnvil 9.8.7 — Test headline";
      const repo = makeRepo(T, { commits: [c1] });
      const r = await runReleaseGithub(repo, { DRY_RUN: "1" });
      expect(r.exitCode, r.stderr).equals(0);
      expect(fileLines(r.stdout)).deep.equals([
        "Version : 9.8.7",
        `Tag     : v9.8.7  (commit ${repo.shas[c1].substring(0, 9)})`,
        "Title   : v9.8.7 — Test headline with `code`",
        "Notes   :",
        "  | ",
        "  | Intro line linking [guide](https://sqlanvil.com/docs/guide/).",
        "  | ",
        "  | - item",
        "  | ",
        "  | **Install:** `npm i -g @sqlanvil/cli@9.8.7`",
        "[dry-run] would tag + push v9.8.7 and create/update the release",
      ]);
    });
  });

  test("@prd T-037.2 DRY_RUN=1 tags nothing, pushes nothing, calls no gh and leaves no notes file", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [0] });
      const r = await runReleaseGithub(repo, { DRY_RUN: "1" });
      expect(r.exitCode, r.stderr).equals(0);
      expectNoTagNoCall(repo);
    });
  });

  test("@prd T-038.1 known-failing E-014 the newest release: commit wins over a later SQLANVIL_VERSION commit", async () => {
    await strictKnownFailure("E-014", async () => {
      await withTemp(async (T) => {
        const c1 = "release: SQLAnvil 9.8.7 — Test headline";
        const c2 = "chore: bump SQLANVIL_VERSION 9.8.7 -> 9.8.8";
        const repo = makeRepo(T, { commits: [c1, c2, "docs: unrelated"] });
        writeGhStub(T, { view: [1] });
        const r = await runReleaseGithub(repo);
        // The symptom, a state: the tag v9.8.7 is put on C2, not on C1.
        if (tagCommitOrUndefined(repo, "R", "v9.8.7") === repo.shas[c2]) {
          throw new KnownFailure(
            "E-014",
            'the tag v9.8.7 is put on the later "chore: bump SQLANVIL_VERSION 9.8.7 -> 9.8.8" commit, not on the "release: SQLAnvil 9.8.7" commit',
          );
        }
        expect(r.exitCode, r.stderr).equals(0);
        expect(tagCommitOrUndefined(repo, "R", "v9.8.7"), "tag v9.8.7 in R points at C1").equals(repo.shas[c1]);
        expect(tagCommitOrUndefined(repo, "origin", "v9.8.7"), "tag v9.8.7 in T/origin.git points at C1").equals(
          repo.shas[c1],
        );
      });
    });
  });

  test("@prd T-038.2 with no matching commit, HEAD is the release commit", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T, { commits: ["docs: unrelated"] });
      writeGhStub(T, { view: [1] });
      const r = await runReleaseGithub(repo);
      expect(r.exitCode, r.stderr).equals(0);
      expect(tagCommit(repo, "R", "v9.8.7"), "tag v9.8.7 in R points at C2").equals(repo.shas["docs: unrelated"]);
    });
  });

  test("@prd T-038.3 a missing tag is created annotated; an existing tag is kept; both are pushed", async () => {
    const c1 = "release: SQLAnvil 9.8.7 — Test headline";
    await withTemp(async (T) => {
      const repo = makeRepo(T, { commits: [c1] });
      writeGhStub(T, { view: [1] });
      const absent = await runReleaseGithub(repo);
      expect(absent.exitCode, `absent: ${absent.stderr}`).equals(0);
      expect(tagType(repo, "v9.8.7"), "absent: v9.8.7 is an annotated tag").equals("tag");
      expect(tagCommit(repo, "R", "v9.8.7"), "absent: v9.8.7 on C1").equals(repo.shas[c1]);
      expect(tagMessage(repo, "v9.8.7"), "absent: tag message").equals("v9.8.7 — Test headline with `code`");
      expect(tagCommit(repo, "origin", "v9.8.7"), "absent: T/origin.git has v9.8.7 on C1").equals(repo.shas[c1]);
    });
    await withTemp(async (T) => {
      const repo = makeRepo(T, { commits: [c1] });
      writeGhStub(T, { view: [1] });
      git(T, repo.R, ["tag", "-a", "v9.8.7", repo.shas.init, "-m", "keep"]);
      const present = await runReleaseGithub(repo);
      expect(present.exitCode, `present: ${present.stderr}`).equals(0);
      expect(tagCommit(repo, "R", "v9.8.7"), "present: v9.8.7 in R still points at I").equals(repo.shas.init);
      expect(tagMessage(repo, "v9.8.7"), "present: message").equals("keep");
      expect(tagCommit(repo, "origin", "v9.8.7"), "present: T/origin.git has v9.8.7 on I").equals(repo.shas.init);
    });
  });

  test("@prd T-038.4 a new release is created with --verify-tag --latest", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [1], create: 0, edit: 0 });
      const r = await runReleaseGithub(repo);
      const calls = ghCalls(T);
      expect(
        calls.length,
        `gh calls ${JSON.stringify(calls.map((c) => c.argv))} (exit ${r.exitCode}: ${r.stderr})`,
      ).equals(2);
      const notes = RELEASE_NOTES["9.8.7"];
      expectCall(calls[0], ["release", "view", "v9.8.7", "--repo", "SQLAnvil/sqlanvil"], notes, "call 1");
      expectCall(
        calls[1],
        [
          "release", "create", "v9.8.7", "--repo", "SQLAnvil/sqlanvil", "--verify-tag", "--latest",
          "--title", "v9.8.7 — Test headline with `code`", "--notes-file", NOTES_FILE,
        ],
        notes,
        "call 2",
      );
    });
  });

  test("@prd T-038.5 an existing release is edited with --latest", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [0], edit: 0 });
      const r = await runReleaseGithub(repo);
      expect(r.stdout, `stdout_contains (${r.stderr})`).to.include("Release v9.8.7 exists — updating title/notes.");
      const calls = ghCalls(T);
      expect(calls.length, `gh calls ${JSON.stringify(calls.map((c) => c.argv))}`).equals(2);
      const notes = RELEASE_NOTES["9.8.7"];
      expectCall(calls[0], ["release", "view", "v9.8.7", "--repo", "SQLAnvil/sqlanvil"], notes, "call 1");
      expectCall(
        calls[1],
        [
          "release", "edit", "v9.8.7", "--repo", "SQLAnvil/sqlanvil",
          "--title", "v9.8.7 — Test headline with `code`", "--notes-file", NOTES_FILE, "--latest",
        ],
        notes,
        "call 2",
      );
    });
  });

  test("@prd T-038.6 after the release, the notes file is removed and Done: is printed", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [1], create: 0 });
      const r = await runReleaseGithub(repo);
      expect(r.exitCode, r.stderr).equals(0);
      const lines = fileLines(r.stdout);
      expect(lines[lines.length - 1], "stdout_last_line").equals(
        "Done: https://github.com/SQLAnvil/sqlanvil/releases/tag/v9.8.7",
      );
      const create = ghCalls(T).find((c) => c.argv[0] === "release" && c.argv[1] === "create");
      expect(create, "the gh stub recorded a create call").not.equals(undefined);
      const notesFile = notesFileArg((create as GhCall).argv);
      expect(notesFile, "the create call has a --notes-file value").not.equals(undefined);
      expect(
        fs.existsSync(path.resolve(repo.R, notesFile as string)),
        `the file named by the create call's --notes-file (${notesFile}) no longer exists`,
      ).equals(false);
    });
  });

  test("@prd T-038.7 a failing gh create stops the script with a non-zero exit", async () => {
    await withTemp(async (T) => {
      const repo = makeRepo(T);
      writeGhStub(T, { view: [1], create: 1 });
      const r = await runReleaseGithub(repo);
      expect(r.exitCode, "exit code").not.equals(0);
      expect(r.stdout, "stdout_does_not_contain").not.to.include("Done: ");
      expect(tags(repo, "origin"), "T/origin.git has v9.8.7").to.include("v9.8.7");
    });
  });

  test("@prd T-038.8 with no release: commit, the newest SQLANVIL_VERSION commit is the release commit", async () => {
    await withTemp(async (T) => {
      const c1 = "build: SQLANVIL_VERSION 9.8.7";
      const repo = makeRepo(T, { commits: [c1, "docs: unrelated"] });
      writeGhStub(T, { view: [1] });
      const r = await runReleaseGithub(repo);
      expect(r.exitCode, r.stderr).equals(0);
      expect(tagCommit(repo, "R", "v9.8.7"), "tag v9.8.7 in R points at C1").equals(repo.shas[c1]);
      expect(tagCommit(repo, "origin", "v9.8.7"), "tag v9.8.7 in T/origin.git points at C1").equals(repo.shas[c1]);
    });
  });

  test("@prd T-038.9 known-failing E-019 an older VERSION creates and edits its release without --latest", async () => {
    await strictKnownFailure("E-019", async () => {
      await withTemp(async (T) => {
        const repo = makeRepo(T);
        writeGhStub(T, { view: [1, 0], create: 0, edit: 0 });
        const first = await runReleaseGithub(repo, { VERSION: "9.8.6" });
        const second = await runReleaseGithub(repo, { VERSION: "9.8.6" });
        const calls = ghCalls(T);
        const isCall = (c: GhCall, verb: string) =>
          c.argv[0] === "release" && c.argv[1] === verb && c.argv[2] === "v9.8.6";
        // The symptom, a state: --latest is passed to gh release create and to gh release edit for v9.8.6.
        const create = calls.find((c) => isCall(c, "create"));
        const edit = calls.find((c) => isCall(c, "edit"));
        if (create && edit && create.argv.includes("--latest") && edit.argv.includes("--latest")) {
          throw new KnownFailure(
            "E-019",
            "release_github passes --latest to gh release create and gh release edit for v9.8.6",
          );
        }
        expect(
          calls.length,
          `gh calls ${JSON.stringify(calls.map((c) => c.argv))} (exits ${first.exitCode}, ${second.exitCode}: ${first.stderr} ${second.stderr})`,
        ).equals(4);
        const notes = RELEASE_NOTES["9.8.6"];
        expectCall(calls[0], ["release", "view", "v9.8.6", "--repo", "SQLAnvil/sqlanvil"], notes, "call 1");
        expectCall(
          calls[1],
          [
            "release", "create", "v9.8.6", "--repo", "SQLAnvil/sqlanvil", "--verify-tag",
            "--title", "v9.8.6 — Older", "--notes-file", NOTES_FILE,
          ],
          notes,
          "call 2",
        );
        expectCall(calls[2], ["release", "view", "v9.8.6", "--repo", "SQLAnvil/sqlanvil"], notes, "call 3");
        expectCall(
          calls[3],
          ["release", "edit", "v9.8.6", "--repo", "SQLAnvil/sqlanvil", "--title", "v9.8.6 — Older", "--notes-file", NOTES_FILE],
          notes,
          "call 4",
        );
        for (const call of calls) {
          expect(call.argv, "no_call_has --latest").not.to.include("--latest");
        }
      });
    });
  });
});
