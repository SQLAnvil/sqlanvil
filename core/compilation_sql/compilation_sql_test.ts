import { expect } from "chai";
import { CompilationSql } from "sa/core/compilation_sql";
import { sqlanvil } from "sa/protos/ts";

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
      const config = sqlanvil.ProjectConfig.create({
        warehouse: "postgres",
        defaultDatabase: "my_db",
        defaultSchema: "public"
      });
      const compiler = new CompilationSql(config, "3.0.0");
      
      expect(compiler.resolveTarget({ database: "my_db", schema: "public", name: "my_table" }))
        .to.equal('"my_db"."public"."my_table"');

      expect(compiler.resolveTarget({ schema: "public", name: "my_table" }))
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
  });
});
