import { expect } from "chai";

import { substituteConnectionCredentials } from "sa/cli/api/commands/connection_credentials";
import { suite, test } from "sa/testing";

suite("connection credential substitution", () => {
  test("substitutes user/password placeholders and escapes single quotes", () => {
    // Double-quoted strings so ${...} stays literal (the placeholders the bridge emits).
    const stmt =
      'create user mapping for current_user server "pg_src_srv" ' +
      "options (user '${SA_CONN:pg_src:user}', password '${SA_CONN:pg_src:password}')";
    const out = substituteConnectionCredentials(stmt, {
      pg_src: { user: "reader", password: "p@ss'word" }
    });
    expect(out).equals(
      'create user mapping for current_user server "pg_src_srv" ' +
        "options (user 'reader', password 'p@ss''word')"
    );
  });

  test("leaves statements without tokens unchanged", () => {
    expect(substituteConnectionCredentials("select 1", {})).equals("select 1");
  });

  test("throws a clear error when the connection is absent", () => {
    const stmt = "options (user '${SA_CONN:missing:user}')";
    expect(() => substituteConnectionCredentials(stmt, {})).to.throw(/Connection "missing"/);
  });

  test("throws a clear error when a required field is missing", () => {
    const stmt = "options (password '${SA_CONN:pg_src:password}')";
    expect(() =>
      substituteConnectionCredentials(stmt, { pg_src: { user: "u" } })
    ).to.throw(/missing "password"/);
  });
});
