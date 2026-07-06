import { execFile } from "child_process";

import { resolveInterpreter } from "sa/cli/api/commands/script_run";
import { sqlanvil } from "sa/protos/ts";

/**
 * `sqlanvil validate` support for script actions — the Python analog of EXPLAIN. Offline and
 * side-effect free: (a) the resolved interpreter satisfies `pythonVersion`; (b) every
 * requirements.txt spec is satisfied by the *installed* environment (importlib.metadata +
 * packaging — nothing is ever installed); (c) the script parses (`py_compile`). All three run
 * inside one small checker program executed by the resolved interpreter itself, so the checks
 * see exactly the environment the script would run in.
 */

/**
 * The embedded checker. argv: <script_path> <requirements_path|""> <version_spec|"">.
 * Prints a JSON object: {"interpreter_version": "3.12.4", "errors": ["..."]}.
 *
 * Specifier evaluation prefers `packaging` (or pip's vendored copy — present in any env that
 * has pip); a minimal numeric-dot comparator covers bare environments, and anything it can't
 * judge is left un-flagged rather than guessed at.
 */
const CHECKER_SOURCE = `
import json, os, sys

script_path, requirements_path, version_spec = sys.argv[1], sys.argv[2], sys.argv[3]
errors = []

import platform
py_version = platform.python_version()

def load_packaging():
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.requirements import Requirement
        return SpecifierSet, Requirement
    except ImportError:
        pass
    try:
        from pip._vendor.packaging.specifiers import SpecifierSet
        from pip._vendor.packaging.requirements import Requirement
        return SpecifierSet, Requirement
    except ImportError:
        return None, None

SpecifierSet, Requirement = load_packaging()

def mini_parse(v):
    import re
    return [int(x) for x in re.findall(r"[0-9]+", v.split("+")[0])][:4]

def mini_check(version, spec):
    import re
    ok = True
    for clause in spec.split(","):
        clause = clause.strip()
        m = re.match(r"(===|==|!=|<=|>=|~=|<|>)\\s*(.+)", clause)
        if not m:
            return None
        op, want = m.group(1), m.group(2).strip()
        if want.endswith(".*"):
            prefix = mini_parse(want[:-2])
            have = mini_parse(version)[:len(prefix)]
            eq = have == prefix
            if (op in ("==", "===") and not eq) or (op == "!=" and eq):
                ok = False
            continue
        a, b = mini_parse(version), mini_parse(want)
        n = max(len(a), len(b))
        a = a + [0] * (n - len(a))
        b = b + [0] * (n - len(b))
        if op in ("==", "==="):
            res = a == b
        elif op == "!=":
            res = a != b
        elif op == "<=":
            res = a <= b
        elif op == ">=":
            res = a >= b
        elif op == "<":
            res = a < b
        elif op == ">":
            res = a > b
        else:  # ~= : at least b, within b's series
            wb = mini_parse(want)
            res = a >= b and a[:max(len(wb) - 1, 1)] == b[:max(len(wb) - 1, 1)]
        if not res:
            ok = False
    return ok

def check_version(version, spec, what):
    if SpecifierSet is not None:
        try:
            if version not in SpecifierSet(spec, prereleases=True):
                errors.append('%s: installed %s does not satisfy "%s"' % (what, version, spec))
            return
        except Exception as e:
            errors.append('%s: could not evaluate specifier "%s": %s' % (what, spec, e))
            return
    if mini_check(version, spec) is False:
        errors.append('%s: installed %s does not satisfy "%s"' % (what, version, spec))

if version_spec:
    check_version(py_version, version_spec, "python interpreter")

if requirements_path:
    from importlib import metadata
    try:
        lines = open(requirements_path).read().splitlines()
    except OSError as e:
        errors.append("requirements: cannot read %s: %s" % (requirements_path, e))
        lines = []
    for raw in lines:
        line = raw.split("#")[0].strip()
        if not line or line.startswith("-"):
            continue
        if Requirement is not None:
            try:
                req = Requirement(line)
            except Exception:
                errors.append('requirements: cannot parse "%s"' % line)
                continue
            if req.marker is not None and not req.marker.evaluate():
                continue
            name, spec = req.name, str(req.specifier)
        else:
            import re
            if ";" in line:
                line = line.split(";")[0].strip()
            m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\\s*(\\[[^\\]]*\\])?\\s*(.*)$", line)
            if not m:
                errors.append('requirements: cannot parse "%s"' % line)
                continue
            name, spec = m.group(1), (m.group(3) or "").strip()
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            errors.append(
                "requirements: %s is not installed%s" % (name, " (need %s)" % spec if spec else "")
            )
            continue
        if spec:
            check_version(installed, spec, "requirements: %s" % name)

try:
    with open(script_path, "rb") as f:
        compile(f.read(), script_path, "exec")
except SyntaxError as e:
    errors.append("syntax: %s (line %s)" % (e.msg, e.lineno))
except (OSError, ValueError) as e:
    errors.append("syntax: cannot compile %s: %s" % (script_path, e))

print(json.dumps({"interpreter_version": py_version, "errors": errors}))
`;

/** Seam for tests: runs the checker and returns its stdout. */
export type CheckerExec = (
  interpreter: string,
  args: string[],
  cwd: string
) => Promise<string>;

const defaultCheckerExec: CheckerExec = (interpreter, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      interpreter,
      args,
      { cwd, timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`checker failed under ${interpreter}: ${err.message}\n${stderr}`.trim())
          );
        } else {
          resolve(stdout);
        }
      }
    );
  });

const failure = (message: string): sqlanvil.IQueryEvaluation => ({
  status: sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE,
  error: { message }
});

/**
 * Validates one script action against the machine's actual environment. Returns QueryEvaluation
 * entries (empty-error SUCCESS on a clean pass), matching the shape `validate` reports for SQL
 * actions, so script results print and classify identically (FAILURE ⇒ downstream BLOCKED).
 */
export async function checkScriptAction(
  script: sqlanvil.IScript,
  projectDir: string,
  checkerExec: CheckerExec = defaultCheckerExec
): Promise<sqlanvil.IQueryEvaluation[]> {
  if (script.language !== "python") {
    return [failure(`no validator for script language "${script.language}"`)];
  }
  let interpreter: string;
  try {
    interpreter = resolveInterpreter(
      { language: script.language, envRoot: script.envRoot },
      projectDir
    );
  } catch (e) {
    return [failure(e.message)];
  }

  let stdout: string;
  try {
    stdout = await checkerExec(
      interpreter,
      ["-c", CHECKER_SOURCE, script.scriptFilename, script.depsFile || "", script.runtimeVersion || ""],
      projectDir
    );
  } catch (e) {
    return [failure(e.message)];
  }

  let parsed: { interpreter_version?: string; errors?: string[] };
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return [failure(`checker returned unparseable output: ${stdout.slice(0, 500)}`)];
  }
  if (parsed.errors && parsed.errors.length > 0) {
    return parsed.errors.map(failure);
  }
  return [{ status: sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS }];
}
