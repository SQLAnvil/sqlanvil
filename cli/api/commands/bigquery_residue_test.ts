import { expect } from "chai";

import { detectResidue, RESIDUE_CLASSES } from "sa/cli/api/commands/bigquery_residue";
import { suite, test } from "sa/testing";

suite("bigquery residue", () => {
  const classes = (sql: string) => detectResidue(sql).map((s) => s.class);

  test("finds the BigQuery functions the converter leaves behind", () => {
    expect(classes("select ifnull(a, b), countif(x > 1), logical_or(f) from t")).to.deep.equal([
      "ifnull",
      "countif",
      "logical-agg",
    ]);
    expect(
      classes("select datetime(ts, 'America/Chicago'), current_datetime() from t"),
    ).to.deep.equal(["datetime", "datetime"]);
    expect(
      classes("select json_value(j, '$.a'), farm_fingerprint(k), to_hex(md5(k)) from t"),
    ).to.deep.equal(["json", "farm-fingerprint", "hash-bytes"]);
    expect(classes("select regexp_contains(x, 'a'), last_day(d) from t")).to.deep.equal([
      "regexp-contains",
      "bq-function",
    ]);
  });

  test("the ones that run and return different results are changes-meaning", () => {
    // Each of these is valid PostgreSQL: nothing fails, the numbers are just different.
    const sites = detectResidue(
      "select regexp_replace(x, 'a', 'b'), concat(first, ' ', last), log(x, 2), log(x)," +
        " extract(week from d) from t",
    );
    expect(sites.map((s) => s.class)).to.deep.equal([
      "regexp-replace-all",
      "null-semantics",
      "log-args",
      "log-args",
      "extract-week",
    ]);
    for (const s of sites) {
      expect(RESIDUE_CLASSES[s.class].severity).equals("changes-meaning");
    }
  });

  test("stays quiet where the PostgreSQL form is already there", () => {
    // Already PostgreSQL: a 'g' flag, a concat that cannot see a NULL, the unit-first
    // date_trunc, a typmod, and PostgreSQL's own information_schema.
    expect(
      detectResidue(
        "select regexp_replace(x, 'a', 'b', 'g'), concat('a', coalesce(b, '')), " +
          "date_trunc('month', d), cast(x as timestamp(3)), format('%s', x) " +
          "from information_schema.columns",
      ),
    ).to.deep.equal([]);
  });

  test("never fires inside a comment, a string or a template", () => {
    expect(
      detectResidue(
        "-- ifnull(a, b)\n/* countif(x) */\nselect 'datetime(ts)', ${funcs.ifnull(`json_value(j)`)} from t",
      ),
    ).to.deep.equal([]);
  });

  test("DATE_TRUNC is flagged only in BigQuery argument order", () => {
    expect(classes("select date_trunc(d, month), timestamp_trunc(ts, day) from t")).to.deep.equal([
      "trunc-order",
      "trunc-order",
    ]);
  });

  test("IF() the function, not IF the scripting statement", () => {
    // `if (select count(*) …) < (…) then` has no top-level commas; the block is reported once,
    // at its END IF, as scripting.
    const sql =
      "if (select count(*) from a) < (select count(*) from b) then\n  select 1;\nend if;\n" +
      "select if(x > 1, 'y', 'n') from t";
    expect(classes(sql)).to.deep.equal(["scripting", "if-function"]);
  });

  test("the business descopes surface as needs-decision", () => {
    // BQML, a JavaScript UDF, and BigQuery's own metadata views: none of these is a translation,
    // each is a question about whether the feature moves at all.
    const sql = [
      "CREATE OR REPLACE MODEL ${self()} REMOTE WITH CONNECTION `p.us.c`;",
      "select * from ML.GENERATE_TEXT(MODEL m, (select 1));",
      "CREATE TEMP FUNCTION jw(a STRING, b STRING) RETURNS FLOAT64 LANGUAGE js AS 'return 1;';",
      "select * from ${ds}.INFORMATION_SCHEMA.COLUMNS;",
      "select * from `proj.ds.INFORMATION_SCHEMA.TABLE_OPTIONS`;",
    ].join("\n");
    const found = classes(sql);
    expect(found).to.deep.equal([
      "bqml",
      "bqml",
      "js-udf",
      "information-schema",
      "information-schema",
    ]);
    for (const c of found) {
      expect(RESIDUE_CLASSES[c].owner).equals("needs-decision");
    }
  });

  test("conversion functions in a call position, not a type position", () => {
    expect(classes("select timestamp(d), date(2024, 1, 2), x::timestamp(3) from t")).to.deep.equal([
      "datetime",
      "bq-function",
    ]);
  });
});
