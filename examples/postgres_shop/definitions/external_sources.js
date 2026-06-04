// JavaScript declaration form: many declare() calls can live in one file — handy
// for declaring a whole external schema at once. Equivalent to one
// type: "declaration" .sqlx per source (see product_catalog.sqlx).
declare({ schema: "raw", name: "product_costs" });
// declare({ schema: "raw", name: "another_source" });   // ...add more here
