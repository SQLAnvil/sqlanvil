import { expect } from "chai";
import * as fs from "fs-extra";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import { readConfigFromWorkflowSettings, validateSqlanvilCoreVersion } from "sa/cli/api/utils";
import { escapeMysqlString, MysqlColumnDef, reconstructColumnDef } from "sa/cli/api/utils/mysql";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { TmpDirFixture } from "sa/testing/fixtures";

suite("readExtensionConfigFromWorkflowSettings", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  function readExtensionConfigFromWorkflowSettings(projectDir: string) {
    return readConfigFromWorkflowSettings(projectDir)?.extension ?? undefined;
  }

  test("returns undefined when workflow_settings.yaml does not exist", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    expect(readExtensionConfigFromWorkflowSettings(projectDir)).to.equal(undefined);
  });

  test("returns undefined when extension is not set in workflow_settings.yaml", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({ defaultProject: "sqlanvil" }),
    );
    expect(readExtensionConfigFromWorkflowSettings(projectDir)).to.equal(undefined);
  });

  test("returns extension config when set in workflow_settings.yaml", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      dumpYaml({
        sqlanvilCoreVersion: "3.0.0",
        defaultProject: "sqlanvil",
        extension: {
          name: "test-extension",
          compilationMode: "PROLOGUE",
        },
      }),
    );
    const result = readExtensionConfigFromWorkflowSettings(projectDir);
    expect(result.name).to.equal("test-extension");
    const mode = result.compilationMode as any;
    if (typeof mode === "string") {
      expect(mode).to.equal("PROLOGUE");
    } else {
      expect(mode).to.equal(sqlanvil.ExtensionCompilationMode.PROLOGUE);
    }
  });

  test("throws error for invalid YAML", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), "invalid: yaml: [");
    expect(() => readExtensionConfigFromWorkflowSettings(projectDir)).to.throw(
      "workflow_settings.yaml is not a valid YAML file",
    );
  });
});

suite("escapeMysqlString", () => {
  test("escapes backslash then single quote", () => {
    expect(escapeMysqlString("it's a \\x")).to.equal("it\\'s a \\\\x");
  });
});

suite("reconstructColumnDef", () => {
  const base: MysqlColumnDef = {
    columnType: "int",
    isNullable: "YES",
    columnDefault: null,
    extra: "",
    collationName: null,
    generationExpression: null,
  };
  test("NOT NULL preserved", () => {
    expect(reconstructColumnDef({ ...base, isNullable: "NO" })).to.equal("int NOT NULL");
  });
  test("nullable column", () => {
    expect(reconstructColumnDef(base)).to.equal("int NULL");
  });
  test("string column keeps COLLATE", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "varchar(20)",
        collationName: "utf8mb4_unicode_ci",
      }),
    ).to.equal("varchar(20) COLLATE utf8mb4_unicode_ci NULL");
  });
  test("auto_increment", () => {
    expect(reconstructColumnDef({ ...base, isNullable: "NO", extra: "auto_increment" })).to.equal(
      "int NOT NULL AUTO_INCREMENT",
    );
  });
  test("literal string default is quoted", () => {
    expect(
      reconstructColumnDef({ ...base, columnType: "varchar(10)", columnDefault: "x" }),
    ).to.equal("varchar(10) NULL DEFAULT 'x'");
  });
  test("numeric default is bare", () => {
    expect(reconstructColumnDef({ ...base, columnDefault: "5" })).to.equal("int NULL DEFAULT 5");
  });
  test("expression default (non-timestamp) is parenthesized", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "char(36)",
        extra: "DEFAULT_GENERATED",
        columnDefault: "uuid()",
      }),
    ).to.equal("char(36) NULL DEFAULT (uuid())");
  });
  test("expression default (CURRENT_TIMESTAMP) is bare", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "datetime",
        extra: "DEFAULT_GENERATED",
        columnDefault: "CURRENT_TIMESTAMP",
      }),
    ).to.equal("datetime NULL DEFAULT CURRENT_TIMESTAMP");
  });
  test("on update current_timestamp", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "datetime",
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        columnDefault: "CURRENT_TIMESTAMP",
      }),
    ).to.equal("datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  });
  test("generated stored column", () => {
    expect(
      reconstructColumnDef({
        ...base,
        isNullable: "NO",
        extra: "STORED GENERATED",
        generationExpression: "(a + b)",
      }),
    ).to.equal("int GENERATED ALWAYS AS ((a + b)) STORED NOT NULL");
  });
});

suite("validateSqlanvilCoreVersion", () => {
  for (const validVersion of [
    "3.0.0",
    "3.1.5",
    "0.0.1",
    "3.0.0-beta.1",
    "2.0.0-alpha.1.2",
    "3.1.0-rc-1",
  ]) {
    test(`accepts valid semantic version "${validVersion}"`, () => {
      expect(() => validateSqlanvilCoreVersion(validVersion)).to.not.throw();
    });
  }

  for (const invalidVersion of [
    "",
    "   ",
    " 3.0.0",
    "3.0.0\n",
    "3.0",
    "v3.0.0",
    "03.0.0",
    "3.01.0",
    "3.0.01",
    "3.0.0-01",
    "3.0.0-.",
    "3.0.0-..",
    "3.0.0-.alpha",
    "3.0.0-alpha.",
    "3.0.0-alpha..1",
    "^3.0.0",
    "~3.0.0",
    ">=3.0.0",
    "*",
    "latest",
    "3.x",
    "3.0.0-",
    "3.0.0+build.1",
    "https://example.invalid/core.tgz",
    "http://example.invalid/core.tgz",
    "git+https://example.invalid/repo.git",
    "file:./local-core.tgz",
    "npm:semver@7.5.4",
    "../other",
    "3.0.0 --loglevel=http",
  ]) {
    test(`rejects invalid string specifier ${JSON.stringify(invalidVersion)}`, () => {
      expect(() => validateSqlanvilCoreVersion(invalidVersion)).to.throw(
        `Invalid sqlanvilCoreVersion ${JSON.stringify(invalidVersion)}: must be a valid semantic version.`,
      );
    });
  }

  for (const { label, value, expectedFormatted } of [
    { label: "array", value: ["3.0.0"], expectedFormatted: '["3.0.0"]' },
    { label: "float", value: 3.1, expectedFormatted: "3.1" },
    { label: "integer", value: 300, expectedFormatted: "300" },
    { label: "NaN", value: NaN, expectedFormatted: "NaN" },
    { label: "Infinity", value: Infinity, expectedFormatted: "Infinity" },
    { label: "BigInt", value: BigInt(1), expectedFormatted: "1" },
    { label: "boolean", value: true, expectedFormatted: "true" },
    { label: "null", value: null, expectedFormatted: "null" },
    { label: "undefined", value: undefined, expectedFormatted: "undefined" },
    {
      label: "object",
      value: { version: "3.0.0" },
      expectedFormatted: '{"version":"3.0.0"}',
    },
  ]) {
    test(`rejects non-string ${label} value`, () => {
      expect(() => validateSqlanvilCoreVersion(value)).to.throw(
        `Invalid sqlanvilCoreVersion ${expectedFormatted}: must be a valid semantic version.`,
      );
    });
  }

  test("rejects circular object without throwing TypeError", () => {
    const circular: unknown[] = [];
    circular.push(circular);

    expect(() => validateSqlanvilCoreVersion(circular)).to.throw(
      /Invalid sqlanvilCoreVersion .*: must be a valid semantic version\./,
    );
  });
});

suite("readConfigFromWorkflowSettings sqlanvilCoreVersion validation", ({ afterEach }) => {
  const tmpDirFixture = new TmpDirFixture(afterEach);

  for (const validVersion of ["3.0.0", "3.1.5", "3.0.0-beta.1"]) {
    test(`reads valid sqlanvilCoreVersion "${validVersion}"`, () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        `defaultProject: sqlanvil\nsqlanvilCoreVersion: ${validVersion}\n`,
      );

      expect(readConfigFromWorkflowSettings(projectDir)?.sqlanvilCoreVersion).to.equal(
        validVersion,
      );
    });
  }

  for (const { label, yamlContent } of [
    { label: "omitted sqlanvilCoreVersion", yamlContent: "defaultProject: sqlanvil\n" },
    {
      label: "null sqlanvilCoreVersion",
      yamlContent: "defaultProject: sqlanvil\nsqlanvilCoreVersion:\n",
    },
    {
      label: "empty string sqlanvilCoreVersion",
      yamlContent: 'defaultProject: sqlanvil\nsqlanvilCoreVersion: ""\n',
    },
    { label: "empty workflow_settings.yaml", yamlContent: "" },
  ]) {
    test(`treats ${label} as unset`, () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(path.join(projectDir, "workflow_settings.yaml"), yamlContent);

      expect(readConfigFromWorkflowSettings(projectDir)?.sqlanvilCoreVersion).to.equal("");
    });
  }

  for (const { label, yamlLine, expectedError } of [
    {
      label: "HTTPS URL",
      yamlLine: 'sqlanvilCoreVersion: "https://example.invalid/core.tgz"',
      expectedError:
        'Invalid sqlanvilCoreVersion "https://example.invalid/core.tgz": must be a valid semantic version.',
    },
    {
      label: "file tarball path",
      yamlLine: 'sqlanvilCoreVersion: "file:./local-core.tgz"',
      expectedError:
        'Invalid sqlanvilCoreVersion "file:./local-core.tgz": must be a valid semantic version.',
    },
    {
      label: "git URL",
      yamlLine: 'sqlanvilCoreVersion: "git+https://example.invalid/repo.git"',
      expectedError:
        'Invalid sqlanvilCoreVersion "git+https://example.invalid/repo.git": must be a valid semantic version.',
    },
    {
      label: "semver range",
      yamlLine: 'sqlanvilCoreVersion: "^3.0.0"',
      expectedError: 'Invalid sqlanvilCoreVersion "^3.0.0": must be a valid semantic version.',
    },
    {
      label: "YAML array",
      yamlLine: 'sqlanvilCoreVersion: ["3.0.0"]',
      expectedError: 'Invalid sqlanvilCoreVersion ["3.0.0"]: must be a valid semantic version.',
    },
    {
      label: "YAML float",
      yamlLine: "sqlanvilCoreVersion: 3.1",
      expectedError: "Invalid sqlanvilCoreVersion 3.1: must be a valid semantic version.",
    },
    {
      label: "YAML boolean",
      yamlLine: "sqlanvilCoreVersion: true",
      expectedError: "Invalid sqlanvilCoreVersion true: must be a valid semantic version.",
    },
    {
      label: "leading zero version",
      yamlLine: 'sqlanvilCoreVersion: "03.0.0"',
      expectedError: 'Invalid sqlanvilCoreVersion "03.0.0": must be a valid semantic version.',
    },
    {
      label: "malformed dot prerelease",
      yamlLine: 'sqlanvilCoreVersion: "3.0.0-."',
      expectedError: 'Invalid sqlanvilCoreVersion "3.0.0-.": must be a valid semantic version.',
    },
    {
      label: "whitespace string",
      yamlLine: 'sqlanvilCoreVersion: "   "',
      expectedError: 'Invalid sqlanvilCoreVersion "   ": must be a valid semantic version.',
    },
    {
      label: "YAML NaN",
      yamlLine: "sqlanvilCoreVersion: .nan",
      expectedError: "Invalid sqlanvilCoreVersion NaN: must be a valid semantic version.",
    },
    {
      label: "YAML Infinity",
      yamlLine: "sqlanvilCoreVersion: .inf",
      expectedError: "Invalid sqlanvilCoreVersion Infinity: must be a valid semantic version.",
    },
  ]) {
    test(`rejects ${label} in workflow_settings.yaml`, () => {
      const projectDir = tmpDirFixture.createNewTmpDir();
      fs.writeFileSync(
        path.join(projectDir, "workflow_settings.yaml"),
        `defaultProject: sqlanvil\n${yamlLine}\n`,
      );

      expect(() => readConfigFromWorkflowSettings(projectDir)).to.throw(expectedError);
    });
  }

  test("rejects circular YAML alias in workflow_settings.yaml without TypeError", () => {
    const projectDir = tmpDirFixture.createNewTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "workflow_settings.yaml"),
      "defaultProject: sqlanvil\nsqlanvilCoreVersion: &a [*a]\n",
    );

    expect(() => readConfigFromWorkflowSettings(projectDir)).to.throw(
      /Invalid sqlanvilCoreVersion .*: must be a valid semantic version\./,
    );
  });
});
