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
${cols.map(c => `    ${c}: "text"`).join(",\n")}
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
    expect(out).to.contain('-- sqlanvil:star-except * from ${ref("orders")} minus (_fivetran_deleted)');
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
    const reasons = result.unresolved.map(u => u.reason).join(" | ");
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
    expect(result.unresolved.map(u => u.reason).join()).to.contain("star expands");
    expect(read(dir, "definitions/s.sqlx")).to.contain("group by all");
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
