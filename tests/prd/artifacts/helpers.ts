// Harness helpers of the artifacts characterization suite (docs/prd/sqlanvil/testing.md, Harness).
import { expect } from "chai";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { cliEntryPointPath } from "sa/cli/index_test_base";
import { getProcessResult, nodePath } from "sa/testing";

export interface ICliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Clean state: a new empty directory made with fs.mkdtemp under os.tmpdir(), removed after the
// case by the test itself. `prefix` lets a case ask for a name holding a single quote.
export async function withTmpDirs<T>(
  count: number,
  fn: (...dirs: string[]) => Promise<T>,
  prefix = "prd-artifacts-",
): Promise<T> {
  const dirs: string[] = [];
  for (let i = 0; i < count; i++) {
    dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  }
  try {
    return await fn(...dirs);
  } finally {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function withTmpDir<T>(fn: (dir: string) => Promise<T>, prefix?: string): Promise<T> {
  return withTmpDirs(1, (dir) => fn(dir), prefix);
}

// The environment of a CLI case: the test's own environment plus NO_COLOR=1.
export function cliEnv(overrides: { [key: string]: string | undefined } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) {
      delete env[key];
    } else {
      env[key] = overrides[key];
    }
  }
  return env;
}

// Lifecycle: the bundled CLI run with Node inside getProcessResult.
export async function runCli(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ICliResult> {
  return getProcessResult(
    execFile(nodePath, [cliEntryPointPath, ...argv], {
      cwd: options.cwd,
      env: options.env || cliEnv(),
    }),
  );
}

// Reads artifacts back through `sqlanvil query "<sql>" <dir> --json` (FR-010, FR-012).
export async function readBack(projectDir: string, sql: string): Promise<any> {
  const result = await runCli(["query", sql, projectDir, "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `read-back query failed (exit ${result.exitCode}): ${sql}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

// The catalog views of a project directory, as ArtifactViews for queryParquet (testing.md,
// Harness, Layout): {name, glob: <dir>/target/catalog/<name>.parquet}.
export function catalogViews(
  dir: string,
  names: string[] = ["actions", "dependencies", "columns"],
): Array<{ name: string; glob: string }> {
  return names.map((name) => ({ name, glob: path.join(dir, "target", "catalog", `${name}.parquet`) }));
}

// Lines of an output: split on "\n"; the newline that ends the last line starts no new line.
export function lines(text: string): string[] {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.split("\n");
}

export const ABSENT = Symbol("absent");

// Assertions: only the fields a case lists are compared; a list compares element by element in
// the case's order; ABSENT means the object has no such key at all, not a key that holds
// undefined or null (testing.md, Assertions).
export function expectFields(actual: any, expected: any, where = "value"): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${where} is a list`).to.equal(true);
    expect(actual.length, `${where} length`).to.equal(expected.length);
    expected.forEach((item: any, i: number) => expectFields(actual[i], item, `${where}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", `${where} is an object`).to.equal(true);
    for (const key of Object.keys(expected)) {
      if (expected[key] === ABSENT) {
        expect(key in actual, `${where} has no key ${key}`).to.equal(false);
      } else {
        expectFields(actual[key], expected[key], `${where}.${key}`);
      }
    }
    return;
  }
  expect(actual, where).to.equal(expected);
}

// Every regular file under `dir`, as a path relative to it.
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else {
        out.push(child);
      }
    }
  };
  walk("");
  return out.sort();
}

// Every file and directory under `dir`, as paths relative to it (directories end in "/").
export function entriesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        out.push(`${child}/`);
        walk(child);
      } else {
        out.push(child);
      }
    }
  };
  walk("");
  return out.sort();
}

// Every file under `dir` with its bytes, for an "unchanged" check.
export function snapshot(dir: string): { [rel: string]: string } {
  const snap: { [rel: string]: string } = {};
  for (const rel of filesUnder(dir)) {
    snap[rel] = fs.readFileSync(path.join(dir, rel)).toString("base64");
  }
  return snap;
}

export function sortedEntries(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

// Runs `fn` with process.env.TMPDIR set to `dir`, then restores it.
export async function withTmpdirEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TMPDIR");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (had) {
      process.env.TMPDIR = previous;
    } else {
      delete process.env.TMPDIR;
    }
  }
}

// Captures everything written to this process's stdout and stderr while `fn` runs.
export async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  let written = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  const capture = (chunk: any, ...rest: any[]) => {
    written += String(chunk);
    const cb = rest.find((r) => typeof r === "function");
    if (cb) {
      cb();
    }
    return true;
  };
  (process.stdout as any).write = capture;
  (process.stderr as any).write = capture;
  try {
    const value = await fn();
    return { value, written };
  } finally {
    (process.stdout as any).write = out;
    (process.stderr as any).write = err;
  }
}
