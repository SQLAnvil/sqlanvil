import { expect } from "chai";

import { sweepOrphanShadows, validate, ValidateDeps } from "sa/cli/api/commands/validate";
import { ValidationResult, ValidationStatus } from "sa/cli/api/commands/validate_graph";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

const SUCCESS = sqlanvil.QueryEvaluation.QueryEvaluationStatus.SUCCESS;
const FAILURE = sqlanvil.QueryEvaluation.QueryEvaluationStatus.FAILURE;

// Minimal compiled graph: src -> mid -> leaf, plus an assertion depending on leaf. All in schema "s".
function graph(): sqlanvil.ICompiledGraph {
  const t = (name: string, ...deps: string[]): sqlanvil.ITable => ({
    target: { schema: "s", name },
    query: `select 1 from ${name}`,
    enumType: sqlanvil.TableType.TABLE,
    dependencyTargets: deps.map(d => ({ schema: "s", name: d }))
  });
  return {
    tables: [t("leaf", "mid"), t("src"), t("mid", "src")],
    assertions: [
      {
        target: { schema: "s", name: "assert_leaf" },
        query: "select 1 from leaf where false",
        dependencyTargets: [{ schema: "s", name: "leaf" }]
      }
    ],
    operations: []
  } as sqlanvil.ICompiledGraph;
}

class FakeDeps implements ValidateDeps {
  public executed: string[] = [];
  public evaluated: string[] = [];
  public schemas: string[] = [];
  constructor(private readonly outcome: Map<string, "SUCCESS" | "FAILURE" | "throw">) {}

  public async listSchemas(): Promise<string[]> {
    return this.schemas;
  }

  public async evaluate(
    action: sqlanvil.ITable | sqlanvil.IAssertion
  ): Promise<sqlanvil.IQueryEvaluation[]> {
    const name = action.target.name;
    this.evaluated.push(name);
    const o = this.outcome.get(name) || "SUCCESS";
    if (o === "throw") {
      throw new Error("connection blew up");
    }
    return [
      {
        status: o === "FAILURE" ? FAILURE : SUCCESS,
        error: o === "FAILURE" ? { message: "syntax error" } : undefined
      }
    ];
  }
  public async execute(sql: string): Promise<void> {
    this.executed.push(sql);
  }
  public validationStubSql(table: sqlanvil.ITable): string {
    return `STUB ${table.target.name}`;
  }
  public createSchemaSql(schema: string): string {
    return `CREATE SCHEMA ${schema}`;
  }
  public dropSchemaCascadeSql(schema: string): string {
    return `DROP SCHEMA ${schema}`;
  }
}

const statusOf = (results: ValidationResult[], name: string): ValidationStatus =>
  results.find(r => r.target.name === name).status;

suite("validate orchestrator", () => {
  test("all valid → every action PASS; stubs created after pass; schema created + dropped", async () => {
    const deps = new FakeDeps(new Map());
    const results = await validate(graph(), deps);

    expect(statusOf(results, "src")).to.equal("PASS");
    expect(statusOf(results, "mid")).to.equal("PASS");
    expect(statusOf(results, "leaf")).to.equal("PASS");
    expect(statusOf(results, "assert_leaf")).to.equal("PASS");

    // Validated upstream-first, assertion last.
    expect(deps.evaluated).to.eql(["src", "mid", "leaf", "assert_leaf"]);
    // A stub was created for each of the 3 tables (assertions get no stub).
    expect(deps.executed).to.include("STUB src");
    expect(deps.executed).to.include("STUB mid");
    expect(deps.executed).to.include("STUB leaf");
    // Shadow schema created and dropped.
    expect(deps.executed[0]).to.equal("CREATE SCHEMA s");
    expect(deps.executed[deps.executed.length - 1]).to.equal("DROP SCHEMA s");
  });

  test("a broken model FAILS; its dependents are BLOCKED, not re-evaluated", async () => {
    const deps = new FakeDeps(new Map([["mid", "FAILURE"]]));
    const results = await validate(graph(), deps);

    expect(statusOf(results, "src")).to.equal("PASS");
    expect(statusOf(results, "mid")).to.equal("FAILURE");
    expect(statusOf(results, "leaf")).to.equal("BLOCKED");
    expect(statusOf(results, "assert_leaf")).to.equal("BLOCKED");

    // leaf/assertion are never evaluated (blocked upstream); no stub for the failed mid.
    expect(deps.evaluated).to.eql(["src", "mid"]);
    expect(deps.executed).to.not.include("STUB mid");
    expect(deps.executed).to.not.include("STUB leaf");
  });

  test("shadow schema is dropped even when evaluate throws", async () => {
    const deps = new FakeDeps(new Map([["mid", "throw"]]));
    let threw = false;
    try {
      await validate(graph(), deps);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(deps.executed).to.include("DROP SCHEMA s"); // finally ran
  });

  test("keepShadow leaves the shadow schema in place", async () => {
    const deps = new FakeDeps(new Map());
    await validate(graph(), deps, { keepShadow: true });
    expect(deps.executed).to.include("CREATE SCHEMA s");
    expect(deps.executed).to.not.include("DROP SCHEMA s");
  });

  test("sweepOrphanShadows drops only stale shadows, never real schemas", async () => {
    const now = 10_000_000;
    const hour = 3_600_000;
    const deps = new FakeDeps(new Map());
    deps.schemas = [
      "public",
      `public_sqlanvil_validate_${now - 2 * hour}`, // stale orphan
      `public_sqlanvil_validate_${now - 60_000}` // in-flight
    ];
    await sweepOrphanShadows(deps, now, hour);
    expect(deps.executed).to.eql([`DROP SCHEMA public_sqlanvil_validate_${now - 2 * hour}`]);
  });
});
