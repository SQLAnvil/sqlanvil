import { expect } from "chai";

import {
  chooseStrategies,
  findStructArrays,
  suggestedSql,
} from "sa/cli/api/commands/struct_arrays";
import { suite, test } from "sa/testing";

suite("struct_arrays", () => {
  const producer = `config { type: "view" }

select
  p.row_id as product_id
  , ARRAY(
      select as struct
          attribute_code as "key"
          , value as "value"
          , frontend_label as "description"
      from raw_decimal as d
      where d.row_id = p.row_id
  ) as decimals
from \${ref("products")} as p
`;

  test("finds the construct, its fields and its source", () => {
    const [site] = findStructArrays("definitions/eav.sqlx", producer);
    expect(site.column).equals("decimals");
    expect(site.fields).deep.equals(["key", "value", "description"]);
    expect(site.source).equals("raw_decimal");
    // The span covers `ARRAY( … ) as decimals`, so a rewrite can replace the whole item.
    expect(producer.slice(site.start, site.end)).to.match(/^ARRAY\(/);
    expect(producer.slice(site.start, site.end)).to.match(/decimals$/);
  });

  test("an ARRAY of scalars is not a struct array", () => {
    // `ARRAY(select x from t)` unnests to a plain column and needs none of this.
    expect(findStructArrays("f.sqlx", 'config { type: "view" }\n\nselect ARRAY(select x from t) as xs\n'))
      .to.have.length(0);
  });

  test("collapse when every read is an UNNEST — the array is a round trip", () => {
    // This is the acuantia shape: rows are gathered into an array of structs and then unnested
    // straight back into a pivot. The array exists because BigQuery makes nesting cheap and
    // joins expensive; neither is true in PostgreSQL, so it need not exist at all.
    const consumer = `config { type: "operations" }

select (select any_value(value) from UNNEST(decimals) where key = 'weight') as weight
from \${ref("eav")}
`;
    const sites = chooseStrategies(findStructArrays("definitions/eav.sqlx", producer), [
      { file: "definitions/eav.sqlx", source: producer },
      { file: "definitions/flat.sqlx", source: consumer },
    ]);
    expect(sites[0].strategy).equals("collapse");
    expect(sites[0].rationale).to.contain("round trip");
    expect(sites[0].consumers).deep.equals([{ file: "definitions/flat.sqlx", unnestOnly: true }]);
  });

  test("child table when a reader does more than unnest it", () => {
    // Passed along whole, the array has to exist as something — and the relational answer to a
    // one-to-many is a child table, not a document column.
    const consumer = `config { type: "view" }

select decimals from \${ref("eav")}
`;
    const sites = chooseStrategies(findStructArrays("definitions/eav.sqlx", producer), [
      { file: "definitions/eav.sqlx", source: producer },
      { file: "definitions/passthrough.sqlx", source: consumer },
    ]);
    expect(sites[0].strategy).equals("child-table");
    expect(sites[0].rationale).to.contain("child table");
  });

  test("the suggested SQL names the real columns, relation and join key", () => {
    // Advice ("consider a child table") leaves the reader to work out the join key and field
    // list, which is the part that takes the time. The construct already says both.
    const [site] = findStructArrays("definitions/eav.sqlx", producer);
    expect(site.correlation).deep.equals({ sourceColumn: "row_id", parentColumn: "row_id" });

    const collapse = suggestedSql({
      ...site,
      strategy: "collapse",
      rationale: "",
      consumers: [{ file: "definitions/flat.sqlx", unnestOnly: true }],
    });
    expect(collapse).to.contain("max(value) filter (where key =");
    expect(collapse).to.contain("raw_decimal");

    const child = suggestedSql({
      ...site,
      strategy: "child-table",
      rationale: "",
      consumers: [{ file: "definitions/x.sqlx", unnestOnly: false }],
    });
    expect(child).to.contain("row_id as row_id");
    expect(child).to.contain("key");
    expect(child).to.contain("join");
  });

  test("an unread array is reported as droppable rather than ported", () => {
    const sites = chooseStrategies(findStructArrays("definitions/eav.sqlx", producer), [
      { file: "definitions/eav.sqlx", source: producer },
    ]);
    expect(sites[0].strategy).equals("collapse");
    expect(sites[0].rationale).to.contain("nothing in the project reads");
  });
});
