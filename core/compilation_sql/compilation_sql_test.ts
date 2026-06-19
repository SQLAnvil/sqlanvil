import { expect } from "chai";
import { CompilationSql } from "sa/core/compilation_sql";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("CompilationSql", () => {
  suite("resolveTarget", () => {
    test("BigQuery: should format with backticks", () => {
      const config = sqlanvil.ProjectConfig.create({
        warehouse: "bigquery",
        defaultDatabase: "my-gcp-project",
        defaultSchema: "my_schema"
      });
      const compiler = new CompilationSql(config, "3.0.0");
      
      expect(compiler.resolveTarget({ database: "my-gcp-project", schema: "my_schema", name: "my_table" }))
        .to.equal("`my-gcp-project.my_schema.my_table`");

      expect(compiler.resolveTarget({ schema: "my_schema", name: "my_table" }))
        .to.equal("`my-gcp-project.my_schema.my_table`");
    });

    test("Postgres: should format with double quotes", () => {
      const configWithDb = sqlanvil.ProjectConfig.create({
        warehouse: "postgres",
        defaultDatabase: "my_db",
        defaultSchema: "public"
      });
      const compilerWithDb = new CompilationSql(configWithDb, "3.0.0");
      expect(compilerWithDb.resolveTarget({ database: "my_db", schema: "public", name: "my_table" }))
        .to.equal('"my_db"."public"."my_table"');

      const configNoDb = sqlanvil.ProjectConfig.create({
        warehouse: "postgres",
        defaultSchema: "public"
      });
      const compilerNoDb = new CompilationSql(configNoDb, "3.0.0");
      expect(compilerNoDb.resolveTarget({ schema: "public", name: "my_table" }))
        .to.equal('"public"."my_table"');
    });

    test("Supabase: should format with double quotes", () => {
      const config = sqlanvil.ProjectConfig.create({
        warehouse: "supabase",
        defaultSchema: "public"
      });
      const compiler = new CompilationSql(config, "3.0.0");

      expect(compiler.resolveTarget({ schema: "public", name: "my_table" }))
        .to.equal('"public"."my_table"');
    });

    test("MySQL: should format with backticks as `schema`.`name`", () => {
      const config = sqlanvil.ProjectConfig.create({
        warehouse: "mysql",
        defaultSchema: "my_db"
      });
      const compiler = new CompilationSql(config, "3.0.0");

      expect(compiler.resolveTarget({ schema: "my_db", name: "my_table" }))
        .to.equal("`my_db`.`my_table`");

      // MySQL has no catalog level, so any database is ignored.
      expect(compiler.resolveTarget({ database: "ignored", schema: "my_db", name: "my_table" }))
        .to.equal("`my_db`.`my_table`");
    });
  });

  suite("sqlString", () => {
    test("BigQuery: escapes using backslashes", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "bigquery" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("it's a \\test")).to.equal("'it\\'s a \\\\test'");
    });

    test("Postgres/Supabase: escapes doubling single quotes", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "postgres" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("it's a \\test")).to.equal("'it''s a \\test'");
    });

    test("MySQL: escapes using backslashes", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "mysql" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("it's a \\test")).to.equal("'it\\'s a \\\\test'");
    });

    test("BigQuery: escapes newlines so quoted literals stay single-line", () => {
      // BigQuery single-quoted string literals cannot span multiple lines, so a
      // raw newline/carriage-return must become the two-char \n / \r escape.
      const config = sqlanvil.ProjectConfig.create({ warehouse: "bigquery" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("line1\nline2")).to.equal("'line1\\nline2'");
      expect(compiler.sqlString("line1\r\nline2")).to.equal("'line1\\r\\nline2'");
    });

    test("MySQL: escapes newlines so quoted literals stay single-line", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "mysql" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("line1\nline2")).to.equal("'line1\\nline2'");
      expect(compiler.sqlString("line1\r\nline2")).to.equal("'line1\\r\\nline2'");
    });

    test("Postgres/Supabase: preserves raw newlines (valid in standard SQL literals)", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "postgres" });
      const compiler = new CompilationSql(config, "3.0.0");
      expect(compiler.sqlString("line1\nline2")).to.equal("'line1\nline2'");
    });
  });

  suite("indexAssertion", () => {
    test("BigQuery: columns are unquoted", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "bigquery" });
      const compiler = new CompilationSql(config, "3.0.0");
      const result = compiler.indexAssertion("`my_schema.my_table`", ["col1", "col2"]);
      expect(result).to.contain("col1, col2");
      expect(result).to.contain("FROM `my_schema.my_table`");
    });

    test("Postgres: columns are double-quoted", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "postgres" });
      const compiler = new CompilationSql(config, "3.0.0");
      const result = compiler.indexAssertion('"my_schema"."my_table"', ["col1", "col2"]);
      expect(result).to.contain('"col1", "col2"');
      expect(result).to.contain('FROM "my_schema"."my_table"');
    });

    test("MySQL: columns are backtick-quoted", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "mysql" });
      const compiler = new CompilationSql(config, "3.0.0");
      const result = compiler.indexAssertion("`my_db`.`my_table`", ["col1", "col2"]);
      expect(result).to.contain("`col1`, `col2`");
      expect(result).to.contain("FROM `my_db`.`my_table`");
    });
  });

  suite("rowConditionsAssertion", () => {
    test("BigQuery: a multiline condition produces a single-line failing_row_condition literal", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "bigquery" });
      const compiler = new CompilationSql(config, "3.0.0");
      const result = compiler.rowConditionsAssertion("`db.schema.test`", ["a > 0\n  AND b > 0"]);

      // The label literal is escaped to a single line so BigQuery accepts it...
      expect(result).to.contain("'a > 0\\n  AND b > 0' AS failing_row_condition");
      // ...while the WHERE clause keeps the raw (newline-containing) expression.
      expect(result).to.contain("WHERE NOT (a > 0\n  AND b > 0)");
    });

    test("joins multiple conditions with UNION ALL", () => {
      const config = sqlanvil.ProjectConfig.create({ warehouse: "bigquery" });
      const compiler = new CompilationSql(config, "3.0.0");
      const result = compiler.rowConditionsAssertion("`db.schema.test`", ["id > 0", "name IS NOT NULL"]);
      expect(result).to.contain("'id > 0' AS failing_row_condition");
      expect(result).to.contain("'name IS NOT NULL' AS failing_row_condition");
      expect(result).to.contain("UNION ALL");
    });
  });
});
