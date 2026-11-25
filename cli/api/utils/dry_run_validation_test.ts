import { expect } from "chai";

import {
  buildDryRunValidationQueries,
  dryRunValidationQueryKey,
} from "sa/cli/api/utils/dry_run_validation";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("dryRunValidationQueryKey", () => {
  test("doesn't depend on which empty fields are set", () => {
    expect(dryRunValidationQueryKey({ schema: "s", name: "t" })).equals(
      dryRunValidationQueryKey({ database: "", schema: "s", name: "t" }),
    );
    expect(dryRunValidationQueryKey({ database: "p", schema: "s", name: "t" })).not.equals(
      dryRunValidationQueryKey({ schema: "s", name: "t" }),
    );
  });
});

suite("buildDryRunValidationQueries", () => {
  const graph = sqlanvil.CompiledGraph.create({
    tables: [
      {
        target: { database: "p", schema: "s", name: "t" },
        preOps: ["  DECLARE x INT64 DEFAULT 1"],
        query: "\n  SELECT x",
        postOps: ["ALTER TABLE `p.s.t` SET OPTIONS (description = 'x')"],
      },
      {
        target: { database: "p", schema: "s", name: "disabled" },
        query: "SELECT 1",
        disabled: true,
      },
      { target: { database: "p", schema: "s", name: "empty" }, query: "  " },
    ],
    assertions: [{ target: { database: "p", schema: "s", name: "a" }, query: "SELECT 2" }],
  });

  test("keys the SELECT query of each enabled table and assertion by its target", () => {
    const queries = buildDryRunValidationQueries(graph);
    expect(Array.from(queries.keys())).deep.equals([
      dryRunValidationQueryKey({ database: "p", schema: "s", name: "t" }),
      dryRunValidationQueryKey({ database: "p", schema: "s", name: "a" }),
    ]);
    expect(queries.get(dryRunValidationQueryKey({ database: "p", schema: "s", name: "a" }))).equals(
      "SELECT 2",
    );
  });

  test("includes pre-operations, excludes post-operations, and keeps the query's lines", () => {
    expect(
      buildDryRunValidationQueries(graph).get(
        dryRunValidationQueryKey({ database: "p", schema: "s", name: "t" }),
      ),
    ).equals("DECLARE x INT64 DEFAULT 1;\n\n  SELECT x");
  });
});
