import { expect } from "chai";

import { coerce } from "sa/cli/api/dbadapters/bigquery_extract";
import { suite, test } from "sa/testing";

suite("bigquery extract value coercion", () => {
  test("null and undefined become null", () => {
    expect(coerce(null)).equals(null);
    expect(coerce(undefined)).equals(null);
  });

  test("primitives pass through", () => {
    expect(coerce(42)).equals(42);
    expect(coerce("abc")).equals("abc");
    expect(coerce(true)).equals(true);
  });

  test("BigQuery date/time/geography wrappers unwrap to their value", () => {
    expect(coerce({ value: "2026-07-27" })).equals("2026-07-27");
    expect(coerce({ value: "2026-07-27T12:34:56.000Z" })).equals("2026-07-27T12:34:56.000Z");
  });

  test("NUMERIC/BIGNUMERIC Big instances stringify losslessly (not JSON-quoted)", () => {
    // The BigQuery client returns NUMERIC as big.js `Big` instances. Left alone, node-postgres
    // JSON.stringifies them into a QUOTED literal ("55") that numeric columns reject with
    // `invalid input syntax for type numeric: ""55""` — found on a real migrated project.
    class Big {
      public s = 1;
      public e = 1;
      public c = [5, 5];
      public toString() {
        return "55";
      }
      public toJSON() {
        return this.toString();
      }
    }
    expect(coerce(new Big())).equals("55");
    // Duck-typed detection also works if the class name is mangled by bundling.
    const anon = { s: -1, e: 1, c: [5, 4, 9, 9], toString: () => "-54.99" };
    expect(coerce(anon)).equals("-54.99");
  });

  test("buffers and arrays pass through for pg's native handling", () => {
    const buf = Buffer.from("bytes");
    expect(coerce(buf)).equals(buf);
    const arr = ["a", "b"];
    expect(coerce(arr)).equals(arr);
  });
});
