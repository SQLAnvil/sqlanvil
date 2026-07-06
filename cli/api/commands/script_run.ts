import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { sqlanvil } from "sa/protos/ts";

/**
 * Run-time execution of script actions (`type: "script"` / the `python:` actions.yaml sugar).
 * The script is spawned runner-side — never on the warehouse — with cwd = the project directory
 * and a minimal env contract (`SA_VARS`, `SA_ACTION_NAME`). No warehouse credentials are ever
 * injected: scripts stage files; `type: "import"` is the loading boundary.
 */

/** Default per-action timeout when the config doesn't set `timeoutMillis`. */
export const DEFAULT_SCRIPT_TIMEOUT_MILLIS = 30 * 60 * 1000;

/** Output kept for error reporting: the last this-many characters of interleaved stdout/stderr. */
export const SCRIPT_OUTPUT_TAIL_CHARS = 8 * 1024;

export interface ScriptRunArgs {
  spec: sqlanvil.IScriptSpec;
  target: sqlanvil.ITarget;
  /** Absolute project directory: the script's cwd and the base for relative spec paths. */
  projectDir: string;
  /** `projectConfig.vars`, passed to the script as the SA_VARS JSON env var. */
  vars?: { [name: string]: string };
  /** Line sink for live script output (defaults to process.stdout). */
  onOutput?: (line: string) => void;
}

/**
 * Resolves the interpreter that runs (and validates) a script action:
 * the declared `venv`'s own interpreter when set, otherwise the language default from PATH.
 * Throws when a declared venv has no interpreter — a configuration error worth failing loudly on,
 * rather than silently falling back to a different environment than the one declared.
 */
export function resolveInterpreter(spec: sqlanvil.IScriptSpec, projectDir: string): string {
  if (spec.language !== "python") {
    throw new Error(`No script runner for language "${spec.language}".`);
  }
  if (spec.envRoot) {
    const candidates =
      process.platform === "win32"
        ? [path.join(projectDir, spec.envRoot, "Scripts", "python.exe")]
        : [path.join(projectDir, spec.envRoot, "bin", "python3"),
           path.join(projectDir, spec.envRoot, "bin", "python")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(
      `Declared venv "${spec.envRoot}" has no python interpreter under ${path.join(
        projectDir,
        spec.envRoot
      )}. Create it (python3 -m venv ${spec.envRoot}) or remove the venv setting.`
    );
  }
  return "python3";
}

/** Keeps the last `limit` characters of appended chunks (for error tails). */
export class TailBuffer {
  private buffer = "";
  constructor(private readonly limit: number) {}
  public append(chunk: string) {
    this.buffer = (this.buffer + chunk).slice(-this.limit);
  }
  public toString() {
    return this.buffer;
  }
}

/**
 * Spawns `<interpreter> <file> <args...>` per the script contract. Resolves on exit code 0;
 * rejects with the exit code (or signal / timeout) and the tail of the script's output.
 */
export async function runScript(args: ScriptRunArgs): Promise<{ exitCode: number }> {
  const { spec, target, projectDir } = args;
  const interpreter = resolveInterpreter(spec, projectDir);
  const scriptPath = path.join(projectDir, spec.filename);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script file not found: ${scriptPath}`);
  }
  const timeoutMillis = spec.timeoutMillis || DEFAULT_SCRIPT_TIMEOUT_MILLIS;
  const onOutput =
    args.onOutput ||
    ((line: string) => process.stdout.write(`  [${target?.name || spec.filename}] ${line}\n`));

  return new Promise((resolve, reject) => {
    const tail = new TailBuffer(SCRIPT_OUTPUT_TAIL_CHARS);
    const child = spawn(interpreter, [spec.filename, ...(spec.args || [])], {
      cwd: projectDir,
      env: {
        ...process.env,
        SA_VARS: JSON.stringify(args.vars || {}),
        SA_ACTION_NAME: target?.name || ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMillis);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail.append(text);
      for (const line of text.split("\n")) {
        if (line.length > 0) {
          onOutput(line);
        }
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("error", err => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${interpreter}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `Script timed out after ${timeoutMillis}ms and was killed.` + tailSuffix(tail)
          )
        );
      } else if (code === 0) {
        resolve({ exitCode: 0 });
      } else {
        reject(
          new Error(
            `Script exited with ${code !== null ? `code ${code}` : `signal ${signal}`}.` +
              tailSuffix(tail)
          )
        );
      }
    });
  });
}

function tailSuffix(tail: TailBuffer): string {
  const text = tail.toString().trim();
  return text ? ` Last output:\n${text}` : "";
}

/** The interpreter's own version, e.g. "3.12.4" (used by validate's env checker). */
export async function interpreterVersion(interpreter: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(interpreter, ["-c", "import platform; print(platform.python_version())"], {
      timeout: 30000
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`Could not run ${interpreter}: ${err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
