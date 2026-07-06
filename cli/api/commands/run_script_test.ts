import { expect } from "chai";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

import { Runner } from "sa/cli/api/commands/run";
import { runScript } from "sa/cli/api/commands/script_run";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("runner script hook", () => {
  function makeRunner(calls: any[], options: any = {}) {
    const graph = sqlanvil.ExecutionGraph.create({
      projectConfig: { warehouse: "postgres", vars: { region: "northeast" } },
      warehouseState: { tables: [] },
      actions: []
    });
    return new Runner({} as any, graph, {
      projectDir: "/proj",
      scriptRun: async (args: any) => {
        calls.push(args);
        return { exitCode: 0 };
      },
      ...options
    });
  }

  test("routes a script task to the script runner with spec + target + projectDir + vars", async () => {
    const calls: any[] = [];
    const runner = makeRunner(calls);
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "sqlanvil", name: "load_openaddresses" },
      type: "script",
      script: {
        language: "python",
        filename: "loader/load.py",
        args: ["northeast"],
        envRoot: ".venv"
      }
    });
    const actionResult: any = { tasks: [] };

    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "script" }),
      actionResult,
      {},
      action
    );

    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.SUCCESSFUL);
    expect(calls).to.have.length(1);
    expect(calls[0].spec.filename).equals("loader/load.py");
    expect(calls[0].spec.args).deep.equals(["northeast"]);
    expect(calls[0].target.name).equals("load_openaddresses");
    expect(calls[0].projectDir).equals("/proj");
    expect(calls[0].vars).deep.equals({ region: "northeast" });
  });

  test("a failing script marks the task FAILED with the error message", async () => {
    const runner = makeRunner([], {
      scriptRun: async () => {
        throw new Error("Script exited with code 3. Last output:\nboom");
      }
    });
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "sqlanvil", name: "load" },
      type: "script",
      script: { language: "python", filename: "loader/load.py" }
    });
    const actionResult: any = { tasks: [] };
    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "script" }),
      actionResult,
      {},
      action
    );
    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
    expect(actionResult.tasks[0].errorMessage).contains("Script exited with code 3");
  });

  test("a missing projectDir fails the task instead of spawning from an unknown cwd", async () => {
    const runner = makeRunner([], { projectDir: undefined });
    const action = sqlanvil.ExecutionAction.create({
      target: { schema: "sqlanvil", name: "load" },
      type: "script",
      script: { language: "python", filename: "loader/load.py" }
    });
    const actionResult: any = { tasks: [] };
    const status = await (runner as any).executeTask(
      null,
      sqlanvil.ExecutionTask.create({ type: "script" }),
      actionResult,
      {},
      action
    );
    expect(status).equals(sqlanvil.TaskResult.ExecutionStatus.FAILED);
    expect(actionResult.tasks[0].errorMessage).contains("projectDir");
  });
});

// The real spawn contract, against the machine's python3 (present on macOS + CI images and a
// documented prerequisite for python script actions).
suite("runScript spawn contract", () => {
  function tmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sqlanvil-script-"));
  }

  test("runs the script with cwd = projectDir and the SA_* env contract", async () => {
    const projectDir = tmpProject();
    fs.mkdirSync(path.join(projectDir, "loader"));
    fs.writeFileSync(
      path.join(projectDir, "loader", "probe.py"),
      [
        "import json, os, sys",
        "out = {",
        '  "cwd": os.getcwd(),',
        '  "vars": json.loads(os.environ["SA_VARS"]),',
        '  "action": os.environ["SA_ACTION_NAME"],',
        '  "args": sys.argv[1:],',
        "}",
        'open("probe_out.json", "w").write(json.dumps(out))'
      ].join("\n")
    );
    const lines: string[] = [];
    await runScript({
      spec: { language: "python", filename: "loader/probe.py", args: ["northeast"] },
      target: { name: "probe" },
      projectDir,
      vars: { region: "ne" },
      onOutput: line => lines.push(line)
    });
    const out = JSON.parse(fs.readFileSync(path.join(projectDir, "probe_out.json"), "utf8"));
    expect(fs.realpathSync(out.cwd)).equals(fs.realpathSync(projectDir));
    expect(out.vars).deep.equals({ region: "ne" });
    expect(out.action).equals("probe");
    expect(out.args).deep.equals(["northeast"]);
  });

  test("a non-zero exit rejects with the exit code and the output tail", async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(
      path.join(projectDir, "fail.py"),
      'import sys\nprint("something went wrong")\nsys.exit(3)\n'
    );
    try {
      await runScript({
        spec: { language: "python", filename: "fail.py" },
        target: { name: "fail" },
        projectDir,
        onOutput: () => undefined
      });
      expect.fail("expected runScript to reject");
    } catch (e) {
      expect(e.message).contains("code 3");
      expect(e.message).contains("something went wrong");
    }
  });

  test("a declared venv without an interpreter fails loudly", async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(path.join(projectDir, "x.py"), "print('hi')\n");
    try {
      await runScript({
        spec: { language: "python", filename: "x.py", envRoot: ".venv" },
        target: { name: "x" },
        projectDir,
        onOutput: () => undefined
      });
      expect.fail("expected runScript to reject");
    } catch (e) {
      expect(e.message).contains('venv ".venv" has no python interpreter');
    }
  });

  test("a timeout kills the script and rejects", { timeout: 30000 }, async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(path.join(projectDir, "sleepy.py"), "import time\ntime.sleep(60)\n");
    try {
      await runScript({
        spec: { language: "python", filename: "sleepy.py", timeoutMillis: 1500 },
        target: { name: "sleepy" },
        projectDir,
        onOutput: () => undefined
      });
      expect.fail("expected runScript to reject");
    } catch (e) {
      expect(e.message).contains("timed out");
    }
  });
});
