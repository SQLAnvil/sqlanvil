// Helpers of the regenerate_docs success paths (FR-041; test-cases/release.yaml T-041.1 to
// T-041.5), a warehouse-level suite: it needs Docker and the network for typedoc's npm install.

import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getProcessResult } from "sa/testing";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A warehouse release case waits at most 30 minutes (testing.md, Harness, Waits). */
export const DOCS_TIMEOUT_MILLIS = 1800000;

export const PAGES = [
  "session.md",
  "assertion.md",
  "table.md",
  "view.md",
  "incrementaltable.md",
  "operation.md",
  "notebook.md",
  "test.md",
  "declaration.md",
  "export.md",
  "import.md",
  "configs.md",
];

function runfilesRoot(): string {
  if (process.env.RUNFILES) {
    return path.resolve(process.env.RUNFILES, "_main");
  }
  if (process.env.TEST_SRCDIR) {
    return path.resolve(process.env.TEST_SRCDIR, "_main");
  }
  return process.cwd();
}

export function runfile(rel: string): string {
  const p = path.join(runfilesRoot(), rel);
  if (!fs.existsSync(p)) {
    throw new Error(`runfile not found: ${rel}`);
  }
  return p;
}

/**
 * The source workspace of the commit under test, found by following `version.bzl` to its real
 * path: first the runfile itself, then the copy in Bazel's own execroot (the output base the
 * runfiles path lies in, outside any darwin-sandbox), whose top-level entries link to the source.
 */
export function workspaceRoot(): string {
  const rf = path.resolve(runfile("version.bzl"));
  const candidates = [rf];
  const i = rf.indexOf("/execroot/");
  if (i >= 0) {
    let base = rf.substring(0, i);
    const s = base.indexOf("/sandbox/");
    if (s >= 0) {
      base = base.substring(0, s);
    }
    candidates.push(path.join(base, "execroot", "_main", "version.bzl"));
  }
  const tried: string[] = [];
  for (const c of candidates) {
    try {
      const root = path.dirname(fs.realpathSync(c));
      if (fs.existsSync(path.join(root, ".git"))) {
        return root;
      }
      tried.push(root);
    } catch (e) {
      tried.push(`${c} (${String(e)})`);
    }
  }
  throw new Error(
    `no workspace root with a .git found from version.bzl (tried ${tried.join(", ")})`,
  );
}

export function fileLines(text: string): string[] {
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t === "" ? [] : t.split("\n");
}

export function writeFile(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function env(extra: { [key: string]: string | undefined } = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      k.startsWith("JS_BINARY__") ||
      k === "NODE_OPTIONS" ||
      k === "COM_REPO" ||
      k === "PROTOC_GEN_DOC_IMAGE"
    ) {
      continue;
    }
    out[k] = v;
  }
  // The script runs with the HOME and PATH the warehouse command passes in with --test_env, so its
  // node, npm and docker are the owner's own and npm uses the owner's cache (testing.md, Harness).
  // The js_test launcher puts its own `node` wrapper directory (a *_node_bin directory, usable only
  // with the parent's JS_BINARY__ variables) in front of that PATH; only that entry is dropped.
  out.PATH = (process.env.PATH || "")
    .split(":")
    .filter((p) => p && !p.includes("_node_bin"))
    .join(":");
  if (process.env.HOME !== undefined) {
    out.HOME = process.env.HOME;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  const child = execFile(file, args, {
    cwd: options.cwd,
    env: options.env || env(),
    maxBuffer: 256 * 1024 * 1024,
  });
  const result = await getProcessResult(child);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export async function withTemp<R>(fn: (dir: string) => Promise<R>): Promise<R> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prd-release-docs-")));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The root node_modules of the owner's checkout. The workspace root found from version.bzl may be
 * Bazel's execroot, whose top-level entries link to the checkout but which holds no node_modules,
 * so the checkout is the workspace named in the output base's DO_NOT_BUILD_HERE file, else the
 * directory that `.git` (then `package.json`) of that root really lies in.
 */
function ownerNodeModules(root: string): string {
  const tried: string[] = [];
  const checkouts: string[] = [];
  // Bazel's output base records the workspace it builds in its DO_NOT_BUILD_HERE file.
  const e = root.indexOf(`${path.sep}execroot${path.sep}`);
  if (e >= 0) {
    const marker = path.join(root.substring(0, e), "DO_NOT_BUILD_HERE");
    try {
      const ws = fs.readFileSync(marker, "utf8").trim();
      if (ws) {
        checkouts.push(ws);
      }
    } catch (err) {
      tried.push(`${marker} (${String(err)})`);
    }
  }
  for (const entry of [".git", "package.json"]) {
    try {
      checkouts.push(path.dirname(fs.realpathSync(path.join(root, entry))));
    } catch (e) {
      tried.push(`${path.join(root, entry)} (${String(e)})`);
    }
  }
  checkouts.push(root);
  for (const c of checkouts) {
    const nm = path.join(c, "node_modules");
    if (fs.existsSync(nm) && fs.statSync(nm).isDirectory()) {
      return nm;
    }
    tried.push(nm);
  }
  throw new Error(`the owner's checkout has no root node_modules (tried ${tried.join(", ")})`);
}

export interface DocsRepo {
  repo: string;
  site: string;
  reference: string;
}

/**
 * T/repo: a `git clone --shared` of the commit under test, with bazel-bin/protos/ts.d.ts and
 * bazel-bin/core/version.ts copied from the outputs of //protos:ts and //core:version, and
 * T/repo/node_modules a symlink to the owner's checkout's root node_modules (the workspace root's;
 * tools/typedoc/node_modules is not linked: the script installs it);
 * T/site/src/content/docs/docs/reference/ made empty.
 */
export function makeDocsRepo(T: string): DocsRepo {
  const root = workspaceRoot();
  const repo = path.join(T, "repo");
  const gitEnv = env({ GIT_CONFIG_NOSYSTEM: "1" });
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    env: gitEnv,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["clone", "-q", "--shared", root, repo], { env: gitEnv });
  execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", head], { env: gitEnv });
  writeFile(
    path.join(repo, "bazel-bin", "protos", "ts.d.ts"),
    fs.readFileSync(runfile("protos/ts.d.ts")),
  );
  writeFile(
    path.join(repo, "bazel-bin", "core", "version.ts"),
    fs.readFileSync(runfile("core/version.ts")),
  );
  fs.symlinkSync(ownerNodeModules(root), path.join(repo, "node_modules"), "dir");
  const site = path.join(T, "site");
  const reference = path.join(site, "src", "content", "docs", "docs", "reference");
  fs.mkdirSync(reference, { recursive: true });
  return { repo, site, reference };
}

export async function regenerate(
  docs: DocsRepo,
  extra: { [key: string]: string | undefined } = {},
): Promise<ProcessResult> {
  return run(path.join(docs.repo, "scripts", "regenerate_docs"), [], {
    cwd: docs.repo,
    env: env({ COM_REPO: docs.site, ...extra }),
  });
}
