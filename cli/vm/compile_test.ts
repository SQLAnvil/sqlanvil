import { expect } from "chai";

import { checkCoreCompatibility, MIN_SUPPORTED_CORE_VERSION } from "sa/cli/vm/compile";
import { suite, test } from "sa/testing";

suite("cli/vm checkCoreCompatibility", () => {
  // Each entry: [cliVersion, coreVersion]
  const supported: Array<[string, string]> = [
    ["1.33.1", MIN_SUPPORTED_CORE_VERSION],
    // The case that used to fail: a CLI one minor ahead of the project's pinned core.
    ["1.33.1", "1.32.10"],
    ["1.33.1", "1.17.0"],
    ["1.33.1", "1.33.1"],
    // Core can be newer than the CLI if the major version is the same.
    ["1.33.1", "1.34.0"],
    ["1.33.1", "1.33.2-beta.0"],
    // Later CLI versions with major 1 still accept the floor.
    ["1.99.4", "1.0.0"],
    // Unknown or invalid CLI version (e.g. running from source): the check is skipped.
    ["0.0.0", "0.0.1"],
    ["not-a-version", "0.0.1"],
  ];
  supported.forEach(([cliVersion, coreVersion]) => {
    test(`CLI ${cliVersion} accepts @sqlanvil/core ${coreVersion}`, () => {
      expect(() => checkCoreCompatibility(coreVersion, cliVersion)).to.not.throw();
    });
  });

  // Each entry: [cliVersion, coreVersion, version range shown in the error]
  const unsupported: Array<[string, string, string]> = [
    // The npm placeholder published before 1.0.0.
    ["1.33.1", "0.0.1", ">=1.0.0 <2.0.0"],
    ["1.33.1", "2.0.0", ">=1.0.0 <2.0.0"],
    ["1.33.1", "2.0.0-alpha.0", ">=1.0.0 <2.0.0"],
    // Pre-release of 1.0.0, which counts as older than 1.0.0.
    ["1.33.1", "1.0.0-alpha.0", ">=1.0.0 <2.0.0"],
    // A CLI with a new major version does not accept Core from the old major.
    ["2.0.0", "1.33.1", ">=2.0.0 <3.0.0"],
  ];
  unsupported.forEach(([cliVersion, coreVersion, range]) => {
    test(`CLI ${cliVersion} rejects @sqlanvil/core ${coreVersion}`, () => {
      expect(() => checkCoreCompatibility(coreVersion, cliVersion)).to.throw(
        `@sqlanvil/core ${coreVersion} is not compatible with @sqlanvil/cli ${cliVersion}. ` +
          `The CLI requires @sqlanvil/core ${range}.`,
      );
    });
  });

  test("error message tells the user how to fix the pin", () => {
    expect(() => checkCoreCompatibility("0.0.1", "1.33.1")).to.throw(
      "Set `sqlanvilCoreVersion: 1.33.1` in workflow_settings.yaml, or pin @sqlanvil/core in " +
        "package.json and run `sqlanvil install`.",
    );
  });
});
