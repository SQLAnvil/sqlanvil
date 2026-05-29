# Packages

[← Back to Home](https://github.com/ihistand/sqlanvil)

SQLAnvil supports npm-style packages that extend the framework with reusable macros, utility tables, and shared includes. Packages are declared in `package.json` as dependencies of `@sqlanvil/core`.

## Using a package

Add a package to your project's `package.json`:

```json
{
  "dependencies": {
    "@sqlanvil/core": "latest",
    "sqlanvil-scd": "^1.0.0"
  }
}
```

Then import it in an `includes/` file:

```js
// includes/scd.js
const scd = require("sqlanvil-scd");
module.exports = { scd };
```

## Creating a package

Creating a package requires familiarity with the SQLAnvil JavaScript API. A package is an npm module that exports functions using the SQLAnvil `session` object.

### Basic structure

A minimal package looks like:

```
my-package/
├── index.js       ← exports your macros/helpers
├── example.js     ← demonstrates usage against a real project
└── README.md
```

### `index.js` example

```js
// A macro that creates a standard SCD Type 2 dimension table
function scdType2(tableName, naturalKey, columns) {
  return session.publish(tableName, {
    type: "incremental",
    uniqueKey: [naturalKey],
    description: `SCD Type 2 dimension: ${tableName}`
  }).query(ctx => `
    SELECT
      ${naturalKey},
      ${columns.join(",\n      ")},
      CURRENT_TIMESTAMP AS valid_from,
      NULL AS valid_to
    FROM ${ctx.ref("staging_" + tableName)}
  `);
}

module.exports = { scdType2 };
```

### Test your package

Connect to a data warehouse (BigQuery, Postgres, or Supabase) and run:

```bash
sqlanvil compile
sqlanvil run --actions my_dimension_table
```

### Publish to npm

Once ready, publish under your own npm scope:

```bash
npm publish --access public
```

## Community packages

> **Note:** The packages below were written for upstream Dataform (BigQuery-only). They may work for BigQuery-targeted SQLAnvil projects. Postgres/Supabase-specific packages are in development.

- [dataform-co/dataform-scd](https://github.com/dataform-co/dataform-scd) — Slowly Changing Dimensions
- [dataform-co/dataform-fivetran-log](https://github.com/dataform-co/dataform-fivetran-log) — Fivetran sync log analysis
- [dataform-co/dataform-segment](https://github.com/dataform-co/dataform-segment) — Segment event modeling

To discuss packages or share your own, open a [GitHub Discussion](https://github.com/ihistand/sqlanvil/discussions).
