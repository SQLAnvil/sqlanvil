import { expect } from "chai";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

import { checkScriptAction } from "sa/cli/api/commands/script_env";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

const SUCCESS = sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS;
const FAILURE = sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE;

// Runs the real embedded checker under the machine's python3 (a documented prerequisite for
// python script actions; present on macOS + CI images).
suite("script env checker", () => {
  function project(files: { [name: string]: string }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlanvil-env-"));
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirsSync(path.dirname(full));
      fs.writeFileSync(full, contents);
    }
    return dir;
  }

  const script = (over: Partial<sqlanvil.IScript> = {}): sqlanvil.IScript =>
    sqlanvil.Script.create({
      target: { schema: "s", name: "load" },
      language: "python",
      scriptFilename: "load.py",
      ...over
    });

  test("a clean script + satisfiable env passes", { timeout: 60000 }, async () => {
    const dir = project({ "load.py": "import csv\nprint('ok')\n" });
    const evals = await checkScriptAction(script({ runtimeVersion: ">=3.8" }), dir);
    expect(evals).to.have.length(1);
    expect(evals[0].status).to.equal(SUCCESS);
  });

  test("a syntax error fails with a syntax message", { timeout: 60000 }, async () => {
    const dir = project({ "load.py": "def broken(:\n" });
    const evals = await checkScriptAction(script(), dir);
    expect(evals[0].status).to.equal(FAILURE);
    expect(evals[0].error.message).to.contain("syntax");
  });

  test("an unsatisfiable interpreter version fails", { timeout: 60000 }, async () => {
    const dir = project({ "load.py": "print('ok')\n" });
    const evals = await checkScriptAction(script({ runtimeVersion: ">=99.0" }), dir);
    expect(evals[0].status).to.equal(FAILURE);
    expect(evals[0].error.message).to.contain("does not satisfy");
  });

  test("a missing requirement is reported by name", { timeout: 60000 }, async () => {
    const dir = project({
      "load.py": "print('ok')\n",
      "requirements.txt": "surely_not_installed_pkg_xyz>=1.0\n"
    });
    const evals = await checkScriptAction(script({ depsFile: "requirements.txt" }), dir);
    expect(evals[0].status).to.equal(FAILURE);
    expect(evals[0].error.message).to.contain("surely_not_installed_pkg_xyz");
    expect(evals[0].error.message).to.contain("not installed");
  });

  test("comments/blank lines/pip options in requirements are ignored", { timeout: 60000 }, async () => {
    const dir = project({
      "load.py": "print('ok')\n",
      "requirements.txt": "# a comment\n\n--index-url https://example.com\n"
    });
    const evals = await checkScriptAction(script({ depsFile: "requirements.txt" }), dir);
    expect(evals[0].status).to.equal(SUCCESS);
  });

  test("a declared venv without an interpreter fails loudly", { timeout: 60000 }, async () => {
    const dir = project({ "load.py": "print('ok')\n" });
    const evals = await checkScriptAction(script({ envRoot: ".venv" }), dir);
    expect(evals[0].status).to.equal(FAILURE);
    expect(evals[0].error.message).to.contain(".venv");
  });

  test("multiple problems are reported as separate evaluations", { timeout: 60000 }, async () => {
    const dir = project({
      "load.py": "def broken(:\n",
      "requirements.txt": "surely_not_installed_pkg_xyz\n"
    });
    const evals = await checkScriptAction(
      script({ depsFile: "requirements.txt", runtimeVersion: ">=99.0" }),
      dir
    );
    expect(evals.length).to.be.greaterThan(2);
    expect(evals.every(e => e.status === FAILURE)).to.equal(true);
  });
});
