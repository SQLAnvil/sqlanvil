import { expect } from "chai";

import { prune } from "sa/cli/api/commands/prune";
import { suite, test } from "sa/testing";
import { sqlanvil } from "sa/protos/ts";

suite("prune", () => {
  // stg_zip_codes (view) reads the zip_codes extract; daily_sales reads stg_app_orders (view),
  // which reads the app_orders declaration.
  function graph(): sqlanvil.ICompiledGraph {
    return {
      tables: [
        {
          target: { schema: "public", name: "stg_app_orders" },
          enumType: sqlanvil.TableType.VIEW,
          query: "select 1",
          dependencyTargets: [{ schema: "public", name: "app_orders" }],
          tags: []
        },
        {
          target: { schema: "public", name: "daily_sales" },
          enumType: sqlanvil.TableType.TABLE,
          query: "select 1",
          dependencyTargets: [{ schema: "public", name: "stg_app_orders" }],
          tags: []
        },
        {
          target: { schema: "public", name: "stg_zip_codes" },
          enumType: sqlanvil.TableType.VIEW,
          query: "select 1",
          dependencyTargets: [{ schema: "bigquery_public_ext", name: "zip_codes" }],
          tags: []
        }
      ],
      operations: [],
      assertions: [],
      exports: [],
      imports: [],
      scripts: [],
      declarations: [{ target: { schema: "public", name: "app_orders" } }],
      extracts: [
        {
          target: { schema: "bigquery_public_ext", name: "zip_codes" },
          connectionName: "bigquery_public",
          platform: "bigquery",
          dependencyTargets: [],
          tags: []
        }
      ]
    } as sqlanvil.ICompiledGraph;
  }

  const names = (actions: Array<{ target?: sqlanvil.ITarget }>) =>
    actions.map(a => a.target.name).sort();

  test("no selectors: everything (including extracts) is kept", () => {
    const pruned = prune(graph(), {});
    expect(names(pruned.tables)).deep.equals(["daily_sales", "stg_app_orders", "stg_zip_codes"]);
    expect(names(pruned.extracts)).deep.equals(["zip_codes"]);
  });

  test("selecting an unrelated chain excludes the extract", () => {
    const pruned = prune(graph(), {
      actions: ["daily_sales"],
      includeDependencies: true
    });
    expect(names(pruned.tables)).deep.equals(["daily_sales", "stg_app_orders"]);
    expect(pruned.extracts).deep.equals([]);
  });

  test("--include-deps pulls the extract in when a selected action reads it", () => {
    const pruned = prune(graph(), {
      actions: ["stg_zip_codes"],
      includeDependencies: true
    });
    expect(names(pruned.tables)).deep.equals(["stg_zip_codes"]);
    expect(names(pruned.extracts)).deep.equals(["zip_codes"]);
  });

  test("selecting the extract directly works", () => {
    const pruned = prune(graph(), { actions: ["zip_codes"] });
    expect(pruned.tables).deep.equals([]);
    expect(names(pruned.extracts)).deep.equals(["zip_codes"]);
  });
});
