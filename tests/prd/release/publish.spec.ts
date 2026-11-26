// Release area: the core publish target in dry-run mode against a stub registry
// (FR-033; test-cases/release.yaml T-033.1; contracts/dependencies/npm-registry.yaml).
//
// T-033.1 starts the binary as `bazel run` starts it: its working directory the real Bazel output
// bin directory that holds packages/@sqlanvil/core/package as a directory (not the runfiles
// symlink tree), with that binary's runfiles variables set, and BAZEL_BINDIR=. .

import { expect } from "chai";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as path from "path";

import { suite, test } from "sa/testing";
import { binary, childEnv, run, runfilesRoot, versions, withTemp, writeFile } from "./helpers";

interface RecordedRequest {
  method: string;
  url: string;
}

/** The npm-registry mock: a local HTTP stub that records every request and uploads nothing. */
async function startStubRegistry(): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method || "", url: req.url || "" });
    req.resume();
    req.on("end", () => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        const s: any = server;
        if (typeof s.closeAllConnections === "function") {
          s.closeAllConnections();
        }
      }),
  };
}

const PACKAGE_DIR = "packages/@sqlanvil/core/package";

/**
 * The bin directories the test's runfiles lie in: the runfiles root is
 * `<execroot>/bazel-out/<config>/bin/<test>.runfiles/_main`; its `<execroot>/bazel-out/<config>/bin`
 * is given first as it is in Bazel's own output base (outside any darwin-sandbox), then as the
 * path the runfiles root itself names.
 */
function binDirCandidates(): string[] {
  const rr = runfilesRoot();
  const r = rr.indexOf(".runfiles");
  const before = r >= 0 ? rr.substring(0, r) : rr;
  const b = before.lastIndexOf(`${path.sep}bin${path.sep}`);
  if (b < 0) {
    return [];
  }
  const runfilesBin = before.substring(0, b + `${path.sep}bin`.length);
  const out: string[] = [];
  const marker = `${path.sep}execroot${path.sep}`;
  const e = runfilesBin.indexOf(marker);
  if (e >= 0) {
    let base = runfilesBin.substring(0, e);
    const s = base.indexOf(`${path.sep}sandbox${path.sep}`);
    if (s >= 0) {
      base = base.substring(0, s);
    }
    out.push(path.join(base, "execroot", runfilesBin.substring(e + marker.length)));
  }
  out.push(runfilesBin);
  return out;
}

/**
 * The real Bazel output bin directory (not the runfiles symlink tree) that holds
 * packages/@sqlanvil/core/package as a directory (not a symlink to one), never a directory inside
 * a `.runfiles` tree.
 */
function realBinDir(): string {
  const tried: string[] = [];
  for (const bin of binDirCandidates()) {
    const pkg = path.join(bin, PACKAGE_DIR);
    if (fs.existsSync(pkg) && fs.lstatSync(pkg).isDirectory()) {
      return bin;
    }
    tried.push(`${bin} (no ${PACKAGE_DIR} directory)`);
  }
  throw new Error(
    `no real Bazel bin directory holding ${PACKAGE_DIR} as a directory (runfiles ${runfilesRoot()}; tried ${tried.join(", ")})`,
  );
}

/** The binary's own path in `bin`, as `bazel run` names it, else its runfiles path. */
function binaryInBin(bin: string, runfilesPath: string): string {
  const rel = path.relative(runfilesRoot(), runfilesPath);
  const inBin = path.join(bin, rel);
  return fs.existsSync(inBin) && fs.statSync(inBin).isFile() ? inBin : runfilesPath;
}

suite("release publish", () => {
  test("@prd T-033.1 core package.publish --dry-run reports the package and uploads nothing", { timeout: 30000 }, async () => {
    await withTemp(async (T) => {
      const userconfig = path.join(T, "npmrc");
      writeFile(userconfig, "");
      const bin = realBinDir();
      // The binary as `bazel run` starts it: its own path in the bin directory, and its runfiles.
      const exe = binaryInBin(bin, binary("packages/@sqlanvil/core", "package.publish"));
      const ownRunfiles = `${exe}.runfiles`;
      const runfilesDir = fs.existsSync(ownRunfiles) ? ownRunfiles : path.dirname(runfilesRoot());
      const stub = await startStubRegistry();
      try {
        // The case's env (BAZEL_BINDIR=.) and the binary's runfiles variables; no npm_config_*
        // variable of the parent reaches npm, and npm reads only the empty user config.
        const env = childEnv({
          BAZEL_BINDIR: ".",
          RUNFILES_DIR: runfilesDir,
          RUNFILES_MANIFEST_FILE: fs.existsSync(path.join(runfilesDir, "MANIFEST"))
            ? path.join(runfilesDir, "MANIFEST")
            : undefined,
        });
        for (const key of Object.keys(env)) {
          if (key.toLowerCase().startsWith("npm_config_")) {
            delete env[key];
          }
        }
        // npm's cache lives in the case's temporary directory: the test sandbox cannot write the
        // owner's ~/.npm, and the case reads nothing of the owner's npm setup.
        env.npm_config_cache = path.join(T, "npm-cache");
        const r = await run(exe, ["--dry-run", `--registry=${stub.url}`, `--userconfig=${userconfig}`], {
          cwd: bin,
          env,
        });
        expect(r.exitCode, `exit_code (cwd ${bin}; stderr: ${r.stderr})`).equals(0);
        expect(r.stdout + "\n" + r.stderr, "stdout_or_stderr_contains").to.include(`@sqlanvil/core@${versions().sv}`);
        const puts = stub.requests.filter((q) => q.method === "PUT");
        expect(puts, "the stub registry receives no PUT request").deep.equals([]);
      } finally {
        await stub.close();
      }
    });
  });
});
