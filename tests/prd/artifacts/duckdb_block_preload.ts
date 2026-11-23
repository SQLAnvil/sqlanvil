// A --require preload (testing.md, Harness, Lifecycle): its module resolver throws for
// @duckdb/node-api, so the DuckDB binding fails to load in the process that preloads it.
// tslint:disable-next-line: no-var-requires
const Module: any = require("module");

const originalResolveFilename = Module._resolveFilename;

export const BLOCKED_MESSAGE = "@duckdb/node-api is blocked by the test preload";

Module._resolveFilename = function (this: any, request: string, ...rest: any[]) {
  if (request === "@duckdb/node-api" || request.startsWith("@duckdb/node-api/")) {
    throw new Error(BLOCKED_MESSAGE);
  }
  return originalResolveFilename.call(this, request, ...rest);
};
