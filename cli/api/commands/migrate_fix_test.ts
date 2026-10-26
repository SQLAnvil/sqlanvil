import { expect } from "chai";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

import { migrateFix } from "sa/cli/api/commands/migrate_fix";
import { suite, test } from "sa/testing";

suite("migrate-fix", () => {
  function project(files: { [rel: string]: string }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlanvil-fix-"));
    for (const [rel, contents] of Object.entries(files)) {
      fs.outputFileSync(path.join(dir, rel), contents);
    }
    return dir;
  }
  const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

  const declaration = (name: string, cols: string[]) =>
    `config {
  type: "declaration",
  connection: "bq_x",
  schema: "src",
  name: ${JSON.stringify(name)},
  columnTypes: {
${cols.map((c) => `    ${c}: "text"`).join(",\n")}
  }
}
`;

  test("expands a star over an introspected declaration", async () => {
    // The dominant real-world shape: strip a Fivetran bookkeeping column from a source table.
    const dir = project({
      "definitions/src/orders.sqlx": declaration("orders", [
        "order_id",
        "customer_id",
        "_fivetran_deleted",
      ]),
      "definitions/vw_orders.sqlx":
        'config { type: "view" }\n\nselect * except (_fivetran_deleted)\nfrom ${ref("orders")}\nwhere not _fivetran_deleted\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(1);

    const out = read(dir, "definitions/vw_orders.sqlx");
    expect(out).to.contain("order_id,");
    expect(out).to.contain("customer_id");
    expect(out).to.not.contain("_fivetran_deleted,"); // excluded from the list…
    expect(out).to.contain("where not _fivetran_deleted"); // …but the predicate still uses it
    // The marker records the source and the exclusions, so the expansion can be re-derived
    // after a later introspect rather than silently drifting.
    expect(out).to.contain(
      '-- sqlanvil:star-except * from ${ref("orders")} minus (_fivetran_deleted)',
    );
  });

  test("a declaration without introspected columns is reported, not guessed", async () => {
    // This is the state migrate-dataform leaves a project in: columnTypes empty with a TODO.
    // Guessing here would silently drop columns.
    const dir = project({
      "definitions/src/orders.sqlx":
        'config {\n  type: "declaration",\n  connection: "bq_x",\n  schema: "src",\n  name: "orders",\n  columnTypes: {\n    // SQLANVIL-MIGRATE(TODO): scaffold the columns from the live source\n  }\n}\n',
      "definitions/vw_orders.sqlx":
        'config { type: "view" }\n\nselect * except (x) from ${ref("orders")}\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(0);
    expect(result.unresolved).to.have.length(1);
    expect(result.unresolved[0].reason).to.contain("has introspect run");
    expect(read(dir, "definitions/vw_orders.sqlx")).to.contain("* except (x)");
  });

  test("resolves through a view, sweeping to a fixpoint", async () => {
    // vw_a must be expanded before vw_b can know what vw_a emits — one pass is not enough.
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "b", "junk"]),
      "definitions/vw_a.sqlx":
        'config { type: "view" }\n\nselect * except (junk) from ${ref("t")}\n',
      "definitions/vw_b.sqlx":
        'config { type: "view" }\n\nselect * except (b) from ${ref("vw_a")}\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(2);
    const b = read(dir, "definitions/vw_b.sqlx");
    expect(b).to.contain("a");
    expect(b).to.not.match(/^\s*b,?$/m); // b was excluded
    expect(b).to.not.contain("junk"); // and junk never reached vw_b at all
  });

  test("qualified stars bind through the alias, and quoting follows the source casing", async () => {
    const dir = project({
      "definitions/src/people.sqlx": declaration("people", ["id", "Email", "drop_me"]),
      "definitions/vw.sqlx":
        'config { type: "view" }\n\nselect p.* except (drop_me)\nfrom ${ref("people")} as p\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(1);
    const out = read(dir, "definitions/vw.sqlx");
    expect(out).to.contain("p.id");
    // A column BigQuery preserved as `Email` must be quoted or PostgreSQL folds it to `email`
    // and the view fails at run time — not at compile time, which is what makes it dangerous.
    expect(out).to.contain('p."Email"');
  });

  test("reports rather than rewrites when the request cannot be satisfied", async () => {
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "b"]),
      // EXCEPT names a column the source does not have.
      "definitions/bad.sqlx":
        'config { type: "view" }\n\nselect * except (nope) from ${ref("t")}\n',
      // Alias that binds to nothing.
      "definitions/bad2.sqlx":
        'config { type: "view" }\n\nselect zz.* except (a) from ${ref("t")} as p\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(0);
    const reasons = result.unresolved.map((u) => u.reason).join(" | ");
    expect(reasons).to.contain("nope");
    expect(reasons).to.contain('aliased "zz"');
  });

  test("GROUP BY ALL becomes ordinals, excluding aggregates and window functions", async () => {
    const dir = project({
      "definitions/g.sqlx":
        'config { type: "view" }\n\n' +
        "select region, channel, sum(amount) as total, count(*) as n\nfrom t\ngroup by all\n",
      // A window function is not an aggregate, and PostgreSQL rejects it in GROUP BY outright —
      // `count(*)` and `count(*) over ()` cannot be told apart by name.
      "definitions/w.sqlx":
        'config { type: "view" }\n\n' +
        "select a, count(*) over (partition by a) as running, max(b) as mx\nfrom t\ngroup by all\n",
      // FILTER sits between the call and OVER.
      "definitions/f.sqlx":
        'config { type: "view" }\n\n' +
        "select k, count(*) filter (where ok) over () as w\nfrom t\ngroup by all\n",
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.groupByAll).equals(3);

    // region and channel group; sum() and count() do not.
    expect(read(dir, "definitions/g.sqlx")).to.contain("group by 1, 2");
    // Only `a` groups: the window function is excluded as well as the aggregate.
    expect(read(dir, "definitions/w.sqlx")).to.contain("group by 1");
    // count(*) FILTER (...) OVER () is still a window function.
    expect(read(dir, "definitions/f.sqlx")).to.contain("group by 1");
  });

  test("GROUP BY ALL over a star is reported — the ordinals are unknowable", async () => {
    const dir = project({
      "definitions/s.sqlx":
        'config { type: "view" }\n\nselect *, count(*) as n from t group by all\n',
    });
    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.groupByAll).equals(0);
    expect(result.unresolved.map((u) => u.reason).join()).to.contain("star expands");
    expect(read(dir, "definitions/s.sqlx")).to.contain("group by all");
  });

  test("folds its outcome back into the migration report", async () => {
    // The report is the handover document for the WHOLE migration. If it keeps describing what
    // the converter saw, it lists work already done and omits what replaced it — so whoever
    // picks the project up next is reading a stale list.
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "junk"]),
      "definitions/ok.sqlx": 'config { type: "view" }\n\nselect * except (junk) from ${ref("t")}\n',
      "definitions/stuck.sqlx":
        'config { type: "view" }\n\nselect * except (nope) from ${ref("t")}\n',
      "migration-report.json": JSON.stringify({
        targetWarehouse: "supabase",
        generator: "test",
        sourceDir: "x",
        sourceConfig: {},
        inventory: { sqlxFiles: 3, jsFiles: 0, byType: {} },
        connections: [],
        overlappingSchemas: [],
        files: [],
        skippedForSafety: [],
        warnings: [],
        todo: [
          {
            id: "star-except",
            title: "SELECT * EXCEPT (…)",
            count: 2,
            severity: "blocks-compile",
            owner: "mechanical",
            locations: [],
          },
          {
            id: "qualify",
            title: "QUALIFY clause",
            count: 1,
            severity: "blocks-compile",
            owner: "mechanical",
            locations: [],
          },
        ],
        applied: [],
      }),
    });

    await migrateFix({ projectDir: dir, write: true });
    const report = JSON.parse(read(dir, "migration-report.json"));

    // The class is rewritten from what ACTUALLY remains — one site, not the original two.
    const star = report.todo.find((t: any) => t.id === "star-except");
    expect(star.count).equals(1);
    expect(star.locations[0].file).equals("definitions/stuck.sqlx");
    // And what is left is by definition what the tool could not decide.
    expect(star.owner).equals("needs-decision");

    // Classes this phase does not own are untouched.
    expect(report.todo.find((t: any) => t.id === "qualify").count).equals(1);

    // The expansion it did do is auditable.
    expect(report.applied.find((a: any) => a.id === "star-except").count).equals(1);
    expect(read(dir, "migration-report.md")).to.contain("## What is left to do");
  });

  test("removes the converter's marker once its site is rewritten, and only then", async () => {
    // migrate-dataform writes these above every star and GROUP BY ALL. Left behind after the
    // rewrite, they send the reader to run a step that has already run.
    const star =
      "-- SQLANVIL-MIGRATE: SELECT * EXCEPT — run `sqlanvil migrate-fix` after introspect to expand it";
    const gba =
      "-- SQLANVIL-MIGRATE: GROUP BY ALL — run `sqlanvil migrate-fix` after introspect to rewrite it";
    const qualify = "-- SQLANVIL-MIGRATE: QUALIFY — rewrite as a subquery/CTE filter";
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "b", "junk"]),
      "definitions/src/u.sqlx":
        'config {\n  type: "declaration",\n  connection: "bq_x",\n  schema: "src",\n  name: "u",\n  columnTypes: {\n  }\n}\n',
      "definitions/done.sqlx": `config { type: "view" }\n\n${star}\nselect * except (junk) from \${ref("t")}\n`,
      "definitions/grouped.sqlx": `config { type: "view" }\n\nselect a, count(*) as n from \${ref("t")}\n${gba}\n${qualify}\ngroup by all\n`,
      "definitions/pending.sqlx": `config { type: "view" }\n\n${star}\nselect * except (x) from \${ref("u")}\n`,
      // The converter flags commented-out SQL too; nothing will ever rewrite it.
      "definitions/commented.sqlx": `config { type: "assertion" }\n\n${gba}\n-- select a from t group by all\nselect 1\n`,
    });

    await migrateFix({ projectDir: dir, write: true });

    const done = read(dir, "definitions/done.sqlx");
    expect(done).to.not.contain("SQLANVIL-MIGRATE");
    expect(done).to.contain("-- sqlanvil:star-except"); // the provenance marker stays
    const grouped = read(dir, "definitions/grouped.sqlx");
    expect(grouped).to.not.contain(gba);
    expect(grouped).to.contain(`${qualify}\ngroup by 1`); // an unrelated marker is untouched
    // Unresolved: the site is still there, so is its marker.
    expect(read(dir, "definitions/pending.sqlx")).to.contain(`${star}\nselect * except (x)`);
    expect(read(dir, "definitions/commented.sqlx")).to.not.contain(gba);
  });

  test("a star over an operations action is reported as unknowable, not as a bad EXCEPT", async () => {
    // An operations action's last SELECT says nothing reliable about the table it leaves
    // behind. Reading its columns from there reported the excluded columns as missing.
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["sku", "attr", "val"]),
      "definitions/op_pivot.sqlx":
        'config { type: "operations", hasOutput: true }\n\ncreate or replace table ${self()} as\nselect sku from ${ref("t")}\n',
      "definitions/vw.sqlx":
        'config { type: "view" }\n\nselect p.* except (price) from (select * from ${ref("op_pivot")}) as p\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(0);
    expect(result.unresolved).to.have.length(1);
    expect(result.unresolved[0].reason).to.contain("op_pivot is an operations action");
    expect(result.unresolved[0].reason).to.not.contain("does not have");
  });

  test("a subquery's columns come from its outermost SELECT, not the one nested inside it", async () => {
    // The dedup shape: number the rows one level up, then drop the counter. Reading the innermost
    // SELECT lost every column added on the way out — reported as a bad EXCEPT when the excluded
    // column was one of them, and silently dropped from the expansion when it was not.
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "b"]),
      "definitions/dedup.sqlx":
        'config { type: "view" }\n\nselect * except (rn)\nfrom (\n  select *, row_number() over (order by a) as rn\n  from (select a, b from ${ref("t")})\n)\nwhere rn = 1\n',
      "definitions/extra.sqlx":
        'config { type: "view" }\n\nselect * except (a)\nfrom (select *, 1 as extra from (select a, b from ${ref("t")}))\n',
    });

    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.unresolved).to.deep.equal([]);
    expect(result.expanded).equals(2);
    expect(read(dir, "definitions/dedup.sqlx")).to.match(/\n\s+a,\n\s+b\nfrom/);
    expect(read(dir, "definitions/extra.sqlx")).to.match(/\n\s+b,\n\s+extra\nfrom/);
  });

  test("a project with no report is left alone", async () => {
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "junk"]),
      "definitions/vw.sqlx": 'config { type: "view" }\n\nselect * except (junk) from ${ref("t")}\n',
    });
    const result = await migrateFix({ projectDir: dir, write: true });
    expect(result.expanded).equals(1);
    expect(fs.existsSync(path.join(dir, "migration-report.json"))).equals(false);
  });

  test("dry run reports without touching the files", async () => {
    const dir = project({
      "definitions/src/t.sqlx": declaration("t", ["a", "junk"]),
      "definitions/vw.sqlx": 'config { type: "view" }\n\nselect * except (junk) from ${ref("t")}\n',
    });
    const before = read(dir, "definitions/vw.sqlx");

    const result = await migrateFix({ projectDir: dir });
    expect(result.expanded).equals(1);
    expect(read(dir, "definitions/vw.sqlx")).equals(before);
  });
});
