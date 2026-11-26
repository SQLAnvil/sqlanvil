// Script cases (testing.md, Harness, the release area): the repository R = T/repo, a new git
// repository with T/origin.git (bare) as origin, the whats-new file WN, T/tmp as TMPDIR, and a
// stub `gh` first on PATH that records each call (argv, and a copy of its --notes-file) and
// answers as the case says (contracts/dependencies/github.yaml, mock).

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { childEnv, fileLines, ProcessResult, run, workspaceRoot, writeFile } from "./helpers";

export const WN_LINES = [
  "# What's new",
  "",
  "## 9.8.7 — Test headline with `code`",
  "",
  "Intro line linking [guide](/docs/guide/).",
  "",
  "- item",
  "",
  "## 9.8.6 — Older",
  "",
  "Old body.",
];

export interface GhAnswers {
  /** Exit codes of successive `gh release view` calls; the last one repeats. */
  view: number[];
  create?: number;
  edit?: number;
}

export interface GhCall {
  argv: string[];
  notes?: string;
}

export interface ScriptRepo {
  T: string;
  R: string;
  origin: string;
  WN: string;
  tmp: string;
  /** Commit SHAs by message ("init" included). */
  shas: { [message: string]: string };
}

function gitEnv(T: string): NodeJS.ProcessEnv {
  const globalConfig = path.join(T, ".gitconfig-empty");
  if (!fs.existsSync(globalConfig)) {
    writeFile(globalConfig, "");
  }
  return childEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig });
}

export function git(T: string, cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(T), encoding: "utf8" });
}

export function writeGhStub(T: string, answers: GhAnswers) {
  const records = path.join(T, "ghstub");
  fs.mkdirSync(records, { recursive: true });
  writeFile(path.join(records, "view_codes"), answers.view.join("\n") + "\n");
  const script = `#!/bin/sh
D='${records}'
n=0
if [ -f "$D/count" ]; then n=$(cat "$D/count"); fi
n=$((n+1))
echo "$n" > "$D/count"
C="$D/call_$n"
mkdir "$C"
i=0
prev=""
for a in "$@"; do
  i=$((i+1))
  printf '%s' "$a" > "$C/arg_$i"
  if [ "$prev" = "--notes-file" ] && [ -f "$a" ]; then cp "$a" "$C/notes"; fi
  prev="$a"
done
echo "$i" > "$C/argc"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  v=0
  if [ -f "$D/views" ]; then v=$(cat "$D/views"); fi
  v=$((v+1))
  echo "$v" > "$D/views"
  code=$(sed -n "\${v}p" "$D/view_codes")
  if [ -z "$code" ]; then code=$(tail -n 1 "$D/view_codes"); fi
  exit "$code"
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then exit ${answers.create === undefined ? 0 : answers.create}; fi
if [ "$1" = "release" ] && [ "$2" = "edit" ]; then exit ${answers.edit === undefined ? 0 : answers.edit}; fi
exit 0
`;
  writeFile(path.join(T, "bin", "gh"), script);
  fs.chmodSync(path.join(T, "bin", "gh"), 0o755);
}

export function ghCalls(T: string): GhCall[] {
  const records = path.join(T, "ghstub");
  const countFile = path.join(records, "count");
  if (!fs.existsSync(countFile)) {
    return [];
  }
  const count = parseInt(fs.readFileSync(countFile, "utf8").trim(), 10);
  const calls: GhCall[] = [];
  for (let n = 1; n <= count; n++) {
    const dir = path.join(records, `call_${n}`);
    const argc = parseInt(fs.readFileSync(path.join(dir, "argc"), "utf8").trim(), 10);
    const argv: string[] = [];
    for (let i = 1; i <= argc; i++) {
      argv.push(fs.readFileSync(path.join(dir, `arg_${i}`), "utf8"));
    }
    const notesFile = path.join(dir, "notes");
    calls.push({ argv, notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : undefined });
  }
  return calls;
}

export function makeRepo(
  T: string,
  options: { versionBzl?: string; wnLines?: string[]; commits?: string[] } = {},
): ScriptRepo {
  const R = path.join(T, "repo");
  const origin = path.join(T, "origin.git");
  const WN = path.join(T, "whats-new.md");
  const tmp = path.join(T, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  writeFile(WN, (options.wnLines || WN_LINES).join("\n") + "\n");
  fs.mkdirSync(R, { recursive: true });
  git(T, T, ["init", "--bare", "-q", origin]);
  git(T, R, ["init", "-q"]);
  git(T, R, ["config", "user.name", "PRD Tester"]);
  git(T, R, ["config", "user.email", "prd-tester@example.invalid"]);
  git(T, R, ["config", "commit.gpgsign", "false"]);
  git(T, R, ["config", "tag.gpgsign", "false"]);
  git(T, R, ["remote", "add", "origin", origin]);
  const script = path.join(R, "scripts", "release_github");
  writeFile(script, fs.readFileSync(path.join(workspaceRoot(), "scripts", "release_github")));
  fs.chmodSync(script, 0o755);
  writeFile(
    path.join(R, "version.bzl"),
    options.versionBzl !== undefined ? options.versionBzl : 'SQLANVIL_VERSION = "9.8.7"\nDF_VERSION = "3.1.8"\n',
  );
  git(T, R, ["add", "-A"]);
  git(T, R, ["commit", "-q", "-m", "init"]);
  const shas: { [message: string]: string } = { init: git(T, R, ["rev-parse", "HEAD"]).trim() };
  for (const message of options.commits || []) {
    git(T, R, ["commit", "-q", "--allow-empty", "-m", message]);
    shas[message] = git(T, R, ["rev-parse", "HEAD"]).trim();
  }
  return { T, R, origin, WN, tmp, shas };
}

/**
 * Runs R/scripts/release_github. `env` holds the case's variables; `undefined` unsets one.
 * WHATS_NEW=WN and TMPDIR=T/tmp unless the case says otherwise; the stub gh dir T/bin first on PATH.
 */
export async function runReleaseGithub(
  repo: ScriptRepo,
  env: { [key: string]: string | undefined } = {},
  cwd?: string,
): Promise<ProcessResult> {
  const base = gitEnv(repo.T);
  delete base.VERSION;
  delete base.DRY_RUN;
  base.PATH = `${path.join(repo.T, "bin")}:${base.PATH}`;
  base.TMPDIR = repo.tmp;
  base.WHATS_NEW = repo.WN;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete base[k];
    } else {
      base[k] = v;
    }
  }
  return run(path.join(repo.R, "scripts", "release_github"), [], { cwd: cwd || repo.R, env: base });
}

export function tags(repo: ScriptRepo, where: "R" | "origin"): string[] {
  const out =
    where === "R"
      ? git(repo.T, repo.R, ["tag", "-l"])
      : git(repo.T, repo.T, ["--git-dir", repo.origin, "tag", "-l"]);
  return fileLines(out);
}

export function tagCommit(repo: ScriptRepo, where: "R" | "origin", tag: string): string {
  const args = ["rev-parse", `${tag}^{commit}`];
  return (
    where === "R" ? git(repo.T, repo.R, args) : git(repo.T, repo.T, ["--git-dir", repo.origin, ...args])
  ).trim();
}

export function tagType(repo: ScriptRepo, tag: string): string {
  return git(repo.T, repo.R, ["cat-file", "-t", tag]).trim();
}

export function tagMessage(repo: ScriptRepo, tag: string): string {
  const out = git(repo.T, repo.R, ["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"]);
  return out.replace(/\n+$/, "");
}
