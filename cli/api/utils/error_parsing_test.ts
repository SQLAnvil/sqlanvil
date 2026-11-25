import { expect } from "chai";

import { mapErrorPositions } from "sa/cli/api/utils/error_parsing";
import { suite, test } from "sa/testing";

suite("mapErrorPositions", () => {
  test("shifts lines by the offset", () => {
    expect(
      mapErrorPositions(
        "Unrecognized name: a at [2:8]",
        "SELECT 1\nSELECT a",
        "x\ny\nSELECT 1\nSELECT a;",
        2,
      ),
    ).equals("Unrecognized name: a at [4:8]");
  });

  test("adds the length of a prefix before the line of the query", () => {
    const query = "SELECT a";
    const statement =
      "create schema if not exists `p.d`;\nbegin\ncreate or replace table `p.d.t` as SELECT a;\nend;";
    expect(mapErrorPositions("Unrecognized name: a at [1:8]", query, statement, 2)).equals(
      `Unrecognized name: a at [3:${"create or replace table `p.d.t` as ".length + 8}]`,
    );
  });

  test("maps every position in the message", () => {
    expect(mapErrorPositions("at [1:1] and at [2:3]", "a\nb", "-\n-\na\nb;", 2)).equals(
      "at [3:1] and at [4:3]",
    );
  });

  test("leaves the column alone when a line doesn't match", () => {
    expect(mapErrorPositions("at [1:5]", "SELECT a", "-\n-\nsomething else", 2)).equals("at [3:5]");
  });
});
