// Cross-warehouse bridge: a live BigQuery Foreign Data Wrapper over Google's
// public ZIP code geo data. One wrapper() call sets up the FDW + server and
// declares a ref()-able foreign table.
wrapper({
  name: "bq_setup",
  provider: "bigquery",
  server: "bq_geo_server",
  serverOptions: {
    project_id: "bigquery-public-data",
    dataset_id: "geo_us_boundaries"
  },
  // saKeyId points at a Vault secret you create once (see README). It is a
  // non-secret pointer; the service-account JSON never lives in this repo.
  credential: { saKeyId: sqlanvil.projectConfig.vars.bq_sa_key_id },
  foreignTables: [
    {
      name: "zip_codes",
      schema: "bq_ext",
      options: { table: "zip_codes", location: "US" },
      columns: {
        zip_code: "text",
        internal_point_lat: "float8",
        internal_point_lon: "float8"
      }
    }
  ]
});
