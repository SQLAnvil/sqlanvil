import { expect } from "chai";

import { parseArgvFlags } from "sa/common/flags";
import { suite, test } from "sa/testing";

suite("flags", () => {
  test("extracts --flag value pairs", () => {
    expect(parseArgvFlags(["node", "cli", "--warehouse", "postgres"])).deep.equals({
      warehouse: "postgres"
    });
  });

  test("extracts --flag=value", () => {
    expect(parseArgvFlags(["node", "cli", "--credentials=/tmp/x.json"])).deep.equals({
      credentials: "/tmp/x.json"
    });
  });

  test("--no-x becomes x=false", () => {
    expect(parseArgvFlags(["node", "cli", "--no-cache"])).deep.equals({ cache: "false" });
  });

  test("ignores leading positionals (command + args before any flag)", () => {
    expect(parseArgvFlags(["node", "cli", "init", "/tmp/dir", "--warehouse", "postgres"])).deep.equals(
      { warehouse: "postgres" }
    );
  });

  test("ignores a positional that follows a flag, instead of throwing", () => {
    // Regression: `init --warehouse postgres /tmp/dir` used to throw
    // "Arg neither flag name nor flag value" at module load, crashing the CLI.
    const argv = ["node", "cli", "init", "--warehouse", "postgres", "/tmp/dir"];
    expect(() => parseArgvFlags(argv)).to.not.throw();
    expect(parseArgvFlags(argv)).deep.equals({ warehouse: "postgres" });
  });
});
