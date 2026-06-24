import { expect } from "chai";

import {
  dependencyBlocked,
  OrderedNode,
  parseShadowTimestamp,
  shadowSchemasToSweep,
  targetKey,
  topoOrder,
  validateShadowSuffix,
  ValidationStatus
} from "sa/cli/api/commands/validate_graph";
import { suite, test } from "sa/testing";

suite("validate_graph", () => {
  const node = (key: string, ...deps: string[]): OrderedNode => ({ key, dependencyKeys: deps });
  const keys = (nodes: OrderedNode[]) => topoOrder(nodes).map(n => n.key);

  test("targetKey joins database.schema.name, skipping empties", () => {
    expect(targetKey({ database: "db", schema: "s", name: "t" })).to.equal("db.s.t");
    expect(targetKey({ schema: "public", name: "t" })).to.equal("public.t");
  });

  test("orders a linear chain upstream-first", () => {
    // declared out of order; leaf -> mid -> src
    expect(keys([node("leaf", "mid"), node("src"), node("mid", "src")])).to.eql([
      "src",
      "mid",
      "leaf"
    ]);
  });

  test("ignores dependencies outside the node set (sources/declarations)", () => {
    // src depends on an external 'raw' not in the set -> src is a root
    expect(keys([node("mid", "src"), node("src", "raw_external")])).to.eql(["src", "mid"]);
  });

  test("is deterministic for a diamond (ascending key tie-break)", () => {
    // a -> b, a -> c, b -> d, c -> d   (keys chosen so order is checkable)
    const order = keys([node("d", "b", "c"), node("b", "a"), node("c", "a"), node("a")]);
    expect(order[0]).to.equal("a");
    expect(order[3]).to.equal("d");
    expect(order).to.eql(["a", "b", "c", "d"]);
  });

  test("does not drop nodes on a cycle (appends leftovers by key)", () => {
    const order = keys([node("x", "y"), node("y", "x"), node("z")]);
    expect(order).to.have.members(["x", "y", "z"]);
    expect(order.length).to.equal(3);
    expect(order[0]).to.equal("z"); // the only acyclic root emits first
  });

  test("dependencyBlocked: any non-PASS dep blocks", () => {
    const status = new Map<string, ValidationStatus>([
      ["ok", "PASS"],
      ["bad", "FAILURE"],
      ["skipped", "SKIPPED"]
    ]);
    expect(dependencyBlocked(["ok"], status)).to.equal(false);
    expect(dependencyBlocked(["ok", "bad"], status)).to.equal(true);
    expect(dependencyBlocked(["ok", "skipped"], status)).to.equal(true);
    expect(dependencyBlocked(["unknown_external"], status)).to.equal(false); // not in graph
  });

  test("validateShadowSuffix + parseShadowTimestamp round-trip", () => {
    const suffix = validateShadowSuffix(1719200000000);
    expect(suffix).to.equal("sqlanvil_validate_1719200000000");
    // A composed schema name (schema + env + shadow suffix) still parses the timestamp.
    expect(parseShadowTimestamp(`public_dev_${suffix}`)).to.equal(1719200000000);
    expect(parseShadowTimestamp("public")).to.equal(null); // a real schema
  });

  test("shadowSchemasToSweep: only marked shadows older than maxAge", () => {
    const now = 2_000_000_000_000; // realistic epoch-ms so subtractions stay positive
    const hour = 3_600_000;
    const names = [
      "public", // real schema — never swept
      "analytics_prod", // real schema
      `public_sqlanvil_validate_${now - 2 * hour}`, // old orphan → swept
      `public_sqlanvil_validate_${now - 60_000}`, // 1 min old (in-flight) → kept
      `staging_sqlanvil_validate_${now - 5 * hour}` // old orphan → swept
    ];
    expect(shadowSchemasToSweep(names, now, hour)).to.eql([
      `public_sqlanvil_validate_${now - 2 * hour}`,
      `staging_sqlanvil_validate_${now - 5 * hour}`
    ]);
  });
});
