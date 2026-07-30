import { expect } from "chai";

import {
  matchBracket,
  relationsIn,
  selectScopes,
  significant,
  splitOnCommas,
  tokenize,
} from "sa/cli/api/commands/sql_lex";
import { suite, test } from "sa/testing";

suite("sql_lex", () => {
  const sig = (sql: string) => significant(tokenize(sql));
  const kinds = (sql: string) => sig(sql).map(t => `${t.kind}:${t.text}`);

  test("template spans are atomic — never read as SQL", () => {
    // The interpolation contains parens, a comma and quotes. Reading inside it is how a
    // regex-based pass mistakes a ref for a function call and its arguments for a select list.
    const toks = sig(`select * from \${ref("acc_mariadb", "sales_order")} as t`);
    const tmpl = toks.find(t => t.kind === "template")!;
    expect(tmpl.text).equals(`\${ref("acc_mariadb", "sales_order")}`);
    expect(toks.filter(t => t.text === "(")).to.have.length(0);

    // Braces nest: an object literal inside the interpolation must not end it early.
    const nested = sig("select ${when(x, `{ a: 1 }`)} as v");
    expect(nested.find(t => t.kind === "template")!.text).equals("${when(x, `{ a: 1 }`)}");
  });

  test("strings, escapes and the quoting BigQuery inverts", () => {
    // '' is an escaped quote, not a terminator — getting this wrong is what let a single stray
    // apostrophe swallow the remainder of a file.
    const toks = sig("select 'it''s fine' as a, 'x' as b");
    const strings = toks.filter(t => t.kind === "string");
    expect(strings).to.have.length(2);
    expect(strings[0].value).equals("it''s fine");

    // A comma inside a literal is not an argument separator — splitting the raw text on commas
    // reads `','` as one, which is how a delimiter argument became three arguments.
    const call = sig("f(a, ',', b)");
    const open = call.findIndex(t => t.text === "(");
    const args = splitOnCommas(call, open + 1, matchBracket(call, open));
    expect(args).to.have.length(3);
    expect(call.slice(...args[1]).map(t => t.text)).deep.equals(["','"]);

    // BigQuery: backtick = identifier, double quote = STRING. The lexer reports what BigQuery
    // meant; deciding what PostgreSQL should say is the caller's job.
    const q = sig('select `my col`, "a string"');
    expect(q[1].kind).equals("backtick-ident");
    expect(q[1].value).equals("my col");
    expect(q[3].kind).equals("quoted-ident");
    expect(q[3].value).equals("a string");

    // Raw-string prefixes belong to the token, so a rewrite can drop them as a unit.
    expect(sig(`select r'\\s+'`)[1].text).equals(`r'\\s+'`);
  });

  test("comments in both spellings, and unterminated input does not throw", () => {
    expect(kinds("-- note\nselect 1")).deep.equals(["word:select", "number:1"]);
    expect(kinds("# note\nselect 1")).deep.equals(["word:select", "number:1"]);
    expect(kinds("select /* mid */ 1")).deep.equals(["word:select", "number:1"]);

    // A converter that gives up on a file is worse than one that converts most of it.
    expect(() => tokenize("select 'unterminated")).to.not.throw();
    expect(() => tokenize("select ${ref(")).to.not.throw();
    expect(() => tokenize("select /* unterminated")).to.not.throw();
  });

  test("select scopes delimit the list and the FROM chain, and nest", () => {
    const toks = sig("select a, b from t where x = 1");
    const [s] = selectScopes(toks);
    expect(toks.slice(s.listStart, s.listEnd).map(t => t.text)).deep.equals(["a", ",", "b"]);
    expect(toks.slice(s.fromStart, s.fromEnd).map(t => t.text)).deep.equals(["t"]);

    // A subquery gets its own scope; the outer scope's clause keywords do not close the inner.
    const nested = sig("select x from (select y from inner_t where y > 1) as d where x > 2");
    const scopes = selectScopes(nested);
    expect(scopes).to.have.length(2);
    expect(nested.slice(scopes[1].fromStart, scopes[1].fromEnd).map(t => t.text)).deep.equals([
      "inner_t",
    ]);

    // `except` as a set operator ends the scope; `select * except (...)` does not — it is a
    // modifier on the star and lives INSIDE the list.
    const starExcept = sig("select * except (a, b) from t");
    const [se] = selectScopes(starExcept);
    expect(starExcept.slice(se.listStart, se.listEnd).map(t => t.text).join(" ")).to.contain(
      "except",
    );
    expect(starExcept.slice(se.fromStart, se.fromEnd).map(t => t.text)).deep.equals(["t"]);
  });

  test("relations and aliases — including the ones that broke the regex version", () => {
    const rel = (sql: string) => {
      const toks = sig(sql);
      const [s] = selectScopes(toks);
      return relationsIn(toks, s.fromStart, s.fromEnd);
    };

    const joined = rel(
      'select 1 from ${ref("a")} as x left join ${ref("b")} y on x.id = y.id',
    );
    expect(joined.map(r => r.alias)).deep.equals(["x", "y"]);
    expect(joined[0].tokens[0].kind).equals("template");

    // No explicit alias: SQL exposes the relation under its own trailing name.
    expect(rel("select 1 from schema.orders")[0].alias).equals("orders");

    // A derived table is a relation too, and its alias is what a qualified star binds to.
    const derived = rel("select 1 from (select * from t) as d");
    expect(derived[0].subquery).equals(true);
    expect(derived[0].alias).equals("d");

    // Join keywords are not relations or aliases — reading `left` as an alias is exactly the
    // kind of error that produced silently wrong column lists.
    const chain = rel("select 1 from a inner join b on a.k = b.k cross join c");
    expect(chain.map(r => r.alias)).deep.equals(["a", "b", "c"]);
  });

  test("matchBracket ignores brackets inside strings and templates", () => {
    const toks = sig(`f('a )', \${ref("x")}, (1))`);
    const open = toks.findIndex(t => t.text === "(");
    expect(matchBracket(toks, open)).equals(toks.length - 1);
  });
});
