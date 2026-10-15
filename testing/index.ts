import { ChildProcess } from "child_process";
import * as path from "path";

export * from "sa/testing/hook";
export * from "sa/testing/suite";
export * from "sa/testing/test";
export * from "sa/testing/runner";

export const nodePath = path.resolve(process.env.JS_BINARY__NODE_BINARY || process.execPath);
export const npmPath = process.env.JS_BINARY__NPM_BINARY || "npm";
export const corePackageTarPath = path.resolve("packages/@sqlanvil/core/package.tar.gz");

export async function getProcessResult(childProcess: ChildProcess) {
  let stderr = "";
  childProcess.stderr.pipe(process.stderr);
  childProcess.stderr.on("data", (chunk) => (stderr += String(chunk)));
  let stdout = "";
  childProcess.stdout.pipe(process.stdout);
  childProcess.stdout.on("data", (chunk) => (stdout += String(chunk)));
  const exitCode: number = await new Promise((resolve) => {
    childProcess.on("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

export function asPlainObject<T>(object: T): T {
  return JSON.parse(JSON.stringify(object)) as T;
}

export function cleanSql(value: string) {
  let cleanValue = value;
  while (true) {
    const newCleanVal = cleanValue
      .replace("  ", " ")
      .replace("\t", " ")
      .replace("\n", " ")
      .replace("( ", "(")
      .replace(" )", ")");
    if (newCleanVal !== cleanValue) {
      cleanValue = newCleanVal;
      continue;
    }
    return newCleanVal.toLowerCase().trim();
  }
}
