import { expect } from "chai";
import Long from "long";

import { dotRepresentation, printExecutedAction, printExecutionGraph } from "sa/cli/console";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("printExecutionGraph", () => {
  const timestampMillis = Long.fromNumber(Date.UTC(2026, 10, 4, 14, 8, 23));

  test("printExecutionGraph outputs plain text summary with warehouse state", () => {
    const executionGraph = sqlanvil.ExecutionGraph.create({
      actions: [
        {
          type: "table",
          tableType: "table",
          target: { database: "proj", schema: "ds", name: "existing_table" },
          tasks: [{ type: "statement", statement: "SELECT 1" }],
        },
        {
          type: "table",
          tableType: "view",
          target: { database: "proj", schema: "ds", name: "type_changed_to_view" },
          tasks: [{ type: "statement", statement: "SELECT 1" }],
        },
        {
          type: "table",
          tableType: "incremental",
          target: { database: "proj", schema: "ds", name: "missing_table" },
          tasks: [],
        },
        {
          type: "assertion",
          target: { database: "proj", schema: "ds", name: "my_assertion" },
          tasks: [{ type: "assertion", statement: "SELECT 1" }],
        },
      ],
      warehouseState: {
        tables: [
          {
            target: { database: "proj", schema: "ds", name: "existing_table" },
            type: sqlanvil.TableMetadata.Type.TABLE,
            lastUpdatedMillis: timestampMillis,
          },
          {
            target: { database: "proj", schema: "ds", name: "type_changed_to_view" },
            type: sqlanvil.TableMetadata.Type.TABLE,
            lastUpdatedMillis: timestampMillis,
          },
        ],
      },
    });

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printExecutionGraph(executionGraph, false);
    } finally {
      process.stdout.write = originalWrite;
    }

    const plainOutput = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainOutput).equals(
      [
        "3 dataset(s):",
        "  ds.existing_table [table] (last modified: 2026-11-04 14:08:23 UTC)",
        "  ds.type_changed_to_view [view] (type: table -> view, last modified: 2026-11-04 14:08:23 UTC)",
        "  ds.missing_table [incremental] [disabled] (does not exist)",
        "1 assertion(s):",
        "  ds.my_assertion",
        "",
      ].join("\n"),
    );
  });
});

// Upstream #2435.
suite("dotRepresentation", () => {
  test("labels tables in graphs that only set the string type", () => {
    const tables = [
      { target: { database: "p", schema: "ds", name: "inc" }, type: "incremental" },
      {
        target: { database: "p", schema: "ds", name: "t" },
        type: "table",
        dependencyTargets: [{ database: "p", schema: "ds", name: "inc" }],
      },
    ];
    const expected = [
      "digraph {",
      '"ds.inc" [label="ds.inc [incremental]"];',
      '"ds.t" [label="ds.t [table]"];',
      '"ds.inc" -> "ds.t";',
      "}",
    ].join("\n");

    // As created in memory: enumType is unset.
    const created = sqlanvil.CompiledGraph.create({ tables });
    expect(dotRepresentation(created, false)).equals(expected);
    // After a protobuf round-trip: the absent enumType defaults to UNKNOWN_TYPE.
    const decoded = sqlanvil.CompiledGraph.decode(sqlanvil.CompiledGraph.encode(created).finish());
    expect(decoded.tables[0].enumType).equals(sqlanvil.TableType.UNKNOWN_TYPE);
    expect(dotRepresentation(decoded, false)).equals(expected);
    // The graph passed in isn't modified.
    expect(decoded.tables[0].enumType).equals(sqlanvil.TableType.UNKNOWN_TYPE);
  });
});

// Upstream #2408: a task wrapped in a script creating its missing dataset reports that script as its
// compiled SQL, and error positions refer to it.
suite("printExecutedAction", () => {
  function captureStderr(fn: () => void): string {
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      fn();
    } finally {
      process.stderr.write = originalWrite;
    }
    return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
  }

  const executionAction: sqlanvil.IExecutionAction = {
    type: "table",
    target: { database: "p", schema: "ds", name: "t" },
    tasks: [{ type: "statement", statement: "SELECT bad" }],
  };
  const failedTask = (compiledSql?: string): sqlanvil.IActionResult => ({
    target: executionAction.target,
    status: sqlanvil.ActionResult.ExecutionStatus.FAILED,
    tasks: [
      {
        status: sqlanvil.TaskResult.ExecutionStatus.FAILED,
        errorMessage: "bigquery error: Unrecognized name: bad at [3:8]",
        compiledSql,
      },
    ],
  });

  test("prints the SQL that was executed for a failed task", () => {
    const wrappedSql = "create schema if not exists `p.ds`;\nbegin\nSELECT bad;\nend;";
    const output = captureStderr(() =>
      printExecutedAction(failedTask(wrappedSql), executionAction),
    );
    expect(output).to.include("> create schema if not exists `p.ds`;\n");
    expect(output).to.include("> SELECT bad;\n");
    expect(output).to.include("> end;\n");
  });

  test("prints the task's statement when no other SQL was executed", () => {
    const output = captureStderr(() => printExecutedAction(failedTask(), executionAction));
    expect(output).to.include("> SELECT bad\n");
    expect(output).not.to.include("create schema");
  });
});
