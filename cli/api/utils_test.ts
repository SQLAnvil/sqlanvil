import { expect } from "chai";
import * as fs from "fs-extra";
import { dump as dumpYaml } from "js-yaml";
import * as path from "path";

import { readConfigFromWorkflowSettings } from "sa/cli/api/utils";
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
      dumpYaml({ defaultProject: "sqlanvil" })
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
      })
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
      "workflow_settings.yaml is not a valid YAML file"
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
    generationExpression: null
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
        collationName: "utf8mb4_unicode_ci"
      })
    ).to.equal("varchar(20) COLLATE utf8mb4_unicode_ci NULL");
  });
  test("auto_increment", () => {
    expect(reconstructColumnDef({ ...base, isNullable: "NO", extra: "auto_increment" })).to.equal(
      "int NOT NULL AUTO_INCREMENT"
    );
  });
  test("literal string default is quoted", () => {
    expect(
      reconstructColumnDef({ ...base, columnType: "varchar(10)", columnDefault: "x" })
    ).to.equal("varchar(10) NULL DEFAULT 'x'");
  });
  test("numeric default is bare", () => {
    expect(reconstructColumnDef({ ...base, columnDefault: "5" })).to.equal("int NULL DEFAULT 5");
  });
  test("expression default (CURRENT_TIMESTAMP) is bare", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "datetime",
        extra: "DEFAULT_GENERATED",
        columnDefault: "CURRENT_TIMESTAMP"
      })
    ).to.equal("datetime NULL DEFAULT CURRENT_TIMESTAMP");
  });
  test("on update current_timestamp", () => {
    expect(
      reconstructColumnDef({
        ...base,
        columnType: "datetime",
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        columnDefault: "CURRENT_TIMESTAMP"
      })
    ).to.equal("datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  });
  test("generated stored column", () => {
    expect(
      reconstructColumnDef({
        ...base,
        isNullable: "NO",
        extra: "STORED GENERATED",
        generationExpression: "(a + b)"
      })
    ).to.equal("int GENERATED ALWAYS AS ((a + b)) STORED NOT NULL");
  });
});
