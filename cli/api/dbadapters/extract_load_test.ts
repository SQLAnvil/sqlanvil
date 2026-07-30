import { expect } from "chai";

import { foldColumns } from "sa/cli/api/dbadapters/extract_load";
import { suite, test } from "sa/testing";

suite("extract_load", () => {
  const target = { schema: "src_ext", name: "orders" };

  test("folds source column names to lower case", () => {
    // BigQuery resolved names case-insensitively; PostgreSQL folds unquoted identifiers and has
    // no case-insensitive mode. Folding here is what keeps the original SQL working unquoted.
    const cols = foldColumns({ Email: "text", FirstName: "text", id: "bigint" }, target);
    expect(cols.map(c => c.target)).deep.equals(["email", "firstname", "id"]);
  });

  test("keeps the source spelling, because rows arrive keyed by it", () => {
    // The failure this prevents is silent: reading `row["email"]` when BigQuery returns
    // `{ Email: ... }` yields undefined for every row, so the column loads as all NULLs and
    // nothing errors.
    const cols = foldColumns({ Email: "text" }, target);
    expect(cols[0]).deep.equals({ source: "Email", target: "email" });

    const row: { [k: string]: any } = { Email: "a@b.c" };
    expect(row[cols[0].source]).equals("a@b.c");
    expect(row[cols[0].target]).equals(undefined);
  });

  test("refuses columns that differ only in case", () => {
    // Folding these would have one silently overwrite the other, so it fails loudly and names
    // both — the source has to disambiguate.
    expect(() => foldColumns({ Email: "text", EMAIL: "text" }, target)).to.throw(
      /differ only in case/,
    );
    expect(() => foldColumns({ Email: "text", EMAIL: "text" }, target)).to.throw(/Email, EMAIL/);
  });

  test("leaves already-lower-case columns untouched", () => {
    const cols = foldColumns({ order_id: "bigint", _fivetran_deleted: "boolean" }, target);
    expect(cols.map(c => c.source)).deep.equals(cols.map(c => c.target));
  });
});
