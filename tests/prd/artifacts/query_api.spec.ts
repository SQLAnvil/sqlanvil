// The query API: FR-023 and FR-024 of docs/prd/sqlanvil/features/artifacts.md.
import { expect } from "chai";

import * as query from "sa/cli/api/commands/query";
import { suite, test } from "sa/testing";

const api: any = query;

interface IExecuteCall {
  sql: string;
  options: any;
}

function recordingAdapter(calls: IExecuteCall[]): any {
  return {
    execute: async (sql: string, options: any) => {
      calls.push({ sql, options });
      return { rows: [{ x: 1 }] };
    },
  };
}

function withoutOnCancel(options: any): any {
  const copy = { ...options };
  delete copy.onCancel;
  return copy;
}

suite("prd artifacts: query API", () => {
  test("@prd T-023.1 run calls execute once with the SQL and the interactive options", async () => {
    const calls: IExecuteCall[] = [];
    const rows = await api.run(recordingAdapter(calls), "select 1", {
      compileConfig: { projectDir: "/does/not/exist" },
      rowLimit: 10,
      byteLimit: 1000,
    });
    expect(rows).to.deep.equal([{ x: 1 }]);
    expect(calls.length).to.equal(1);
    expect(calls[0].sql).to.equal("select 1");
    expect(calls[0].options.interactive).to.equal(true);
    expect(calls[0].options.rowLimit).to.equal(10);
    expect(calls[0].options.byteLimit).to.equal(1000);
    expect(typeof calls[0].options.onCancel).to.equal("function");
  });

  test("@prd T-023.2 run rejects with the adapter's error", async () => {
    const E = new Error("bad");
    const adapter = {
      execute: async (): Promise<any> => {
        throw E;
      },
    };
    let caught: any;
    try {
      await api.run(adapter, "select 1");
    } catch (e) {
      caught = e;
    }
    expect(caught, "rejects with the same Error object").to.equal(E);
  });

  test("@prd T-023.3 cancelling run calls the handler registered through onCancel", async () => {
    let hCalls = 0;
    const adapter = {
      execute: (_sql: string, options: any) =>
        new Promise((resolve) => {
          options.onCancel(() => {
            hCalls++;
            resolve({ rows: [] });
          });
        }),
    };
    const p = api.run(adapter, "select 1");
    p.cancel();
    const rows = await p;
    expect(rows).to.deep.equal([]);
    expect(hCalls).to.equal(1);
  });

  test("@prd T-023.4 run ignores options.compileConfig", async () => {
    const calls: IExecuteCall[] = [];
    const adapter = recordingAdapter(calls);
    const first = await api.run(adapter, "select 1", {
      compileConfig: { projectDir: "/does/not/exist" },
    });
    const second = await api.run(adapter, "select 1", {});
    expect(first).to.deep.equal([{ x: 1 }]);
    expect(second).to.deep.equal([{ x: 1 }]);
    expect(calls.length).to.equal(2);
    expect(calls[0].sql).to.equal(calls[1].sql);
    expect(withoutOnCancel(calls[0].options)).to.deep.equal(withoutOnCancel(calls[1].options));
  });

  test("@prd T-024.1 evaluate resolves with the adapter's first evaluation", async () => {
    const seen: string[] = [];
    const adapter = {
      evaluate: async (sql: string) => {
        seen.push(sql);
        return [
          { status: "SUCCESS", id: "e1" },
          { status: "FAILURE", id: "e2" },
        ];
      },
    };
    const result = await api.evaluate(adapter, "select 1");
    expect(result).to.deep.equal({ status: "SUCCESS", id: "e1" });
    expect(seen).to.deep.equal(["select 1"]);
  });
});
