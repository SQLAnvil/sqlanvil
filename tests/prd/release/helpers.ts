// Shared helpers of the release characterization suite (tests/prd/release).
// Every expected value lives in the spec files and comes from docs/prd/sqlanvil.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getProcessResult } from "sa/testing";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The `_main` directory of the test's runfiles (the js_test's working directory). */
export function runfilesRoot(): string {
  if (process.env.RUNFILES) {
    return path.resolve(process.env.RUNFILES, "_main");
  }
  if (process.env.TEST_SRCDIR) {
    return path.resolve(process.env.TEST_SRCDIR, "_main");
  }
  return process.cwd();
}

/** The absolute path of a runfile, given relative to the workspace root; throws when it is missing. */
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
  throw new Error(`no workspace root with a .git found from version.bzl (tried ${tried.join(", ")})`);
}

/**
 * A repository source file of the commit under test (LICENSE, protos/core.proto, ...), read from
 * the workspace root: source files of other packages are not exported as Bazel labels.
 */
export function source(rel: string): string {
  const p = path.join(workspaceRoot(), rel);
  if (!fs.existsSync(p)) {
    throw new Error(`source file not found: ${rel}`);
  }
  return p;
}

/** SV and DV: SQLANVIL_VERSION and DF_VERSION of version.bzl at the commit under test. */
export function versions(): { sv: string; dv: string } {
  const text = fs.readFileSync(runfile("version.bzl"), "utf8");
  const sv = /SQLANVIL_VERSION\s*=\s*"([^"]+)"/.exec(text);
  const dv = /DF_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!sv || !dv) {
    throw new Error("version.bzl has no SQLANVIL_VERSION or DF_VERSION");
  }
  return { sv: sv[1], dv: dv[1] };
}

/** HEADER: the 13 lines of LICENSE_HEADER in packages/index.bzl. */
export function licenseHeader(): string[] {
  const text = fs.readFileSync(source("packages/index.bzl"), "utf8");
  const first = "// Copyright 2023 Google LLC";
  const last = "// limitations under the License.";
  const start = text.indexOf(first);
  const end = start < 0 ? -1 : text.indexOf(last, start);
  if (start < 0 || end < 0) {
    throw new Error("packages/index.bzl holds no LICENSE_HEADER from the Copyright line to the License line");
  }
  const lines = text.substring(start, end + last.length).split("\n");
  if (lines.length !== 13) {
    throw new Error(`LICENSE_HEADER of packages/index.bzl is ${lines.length} lines, not 13`);
  }
  return lines;
}

/** Splits text into lines as a file is: on "\n", one final newline allowed. */
export function fileLines(text: string): string[] {
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t === "" ? [] : t.split("\n");
}

/** The executable a Bazel binary target puts in the runfiles. */
export function binary(pkg: string, name: string): string {
  const candidates = [
    `${pkg}/${name}`,
    `${pkg}/${name}_/${name}`,
    `${pkg}/${name}.sh`,
    `${pkg}/${name}_/${name}.sh`,
  ];
  for (const c of candidates) {
    const p = path.join(runfilesRoot(), c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return p;
    }
  }
  throw new Error(`no executable for //${pkg}:${name} in the runfiles (tried ${candidates.join(", ")})`);
}

/**
 * The environment of a child: this process's environment without the parent js_test's
 * launcher variables, with `extra` applied; an `undefined` value unsets the variable.
 */
export function childEnv(extra: { [key: string]: string | undefined } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("JS_BINARY__") || k === "NODE_OPTIONS") {
      continue;
    }
    env[k] = v;
  }
  env.PATH = `${process.env.PATH || ""}:/usr/bin:/bin:/usr/sbin:/sbin`;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return env;
}

export async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  const child = execFile(file, args, {
    cwd: options.cwd,
    env: options.env || childEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  const result = await getProcessResult(child);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** T: a new empty temporary directory (real path) under os.tmpdir(), removed after `fn`. */
export async function withTemp<R>(fn: (dir: string) => Promise<R>, prefix = "prd-release-"): Promise<R> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFile(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every path (files, directories, symlinks) beneath `dir`, at any depth, relative to it. */
export function allPaths(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) {
        walk(r);
      }
    }
  };
  walk("");
  return out.sort();
}

/** The files beneath `dir`, at every depth, with their bytes (a symlink as its target). */
export function fileContents(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of allPaths(dir)) {
    const p = path.join(dir, r);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      out.set(r, `symlink:${fs.readlinkSync(p)}`);
    } else if (st.isFile()) {
      out.set(r, fs.readFileSync(p).toString("base64"));
    }
  }
  return out;
}

export function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      return false;
    }
  }
  return true;
}
