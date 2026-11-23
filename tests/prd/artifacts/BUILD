load("//testing:index.bzl", "ts_test_suite")

package(default_visibility = ["//visibility:public"])

# The artifacts area's characterization suite (docs/prd/sqlanvil/testing.md, Layout).
# Every test is tagged integration; prd-artifacts selects this suite alone.
ts_test_suite(
    name = "tests",
    srcs = [
        "cli.spec.ts",
        "docs_model.spec.ts",
        "duckdb_block_preload.ts",
        "duckdb_fail_child.ts",
        "duckdb_load.spec.ts",
        "fixtures.ts",
        "helpers.ts",
        "known_failing.ts",
        "query_api.spec.ts",
        "render.spec.ts",
        "writer.spec.ts",
    ],
    data = [
        "//:node_modules/@duckdb/node-api",
        "//:node_modules/long",
        "//packages/@sqlanvil/cli:bundle",
        "//packages/@sqlanvil/cli:json",
        "//packages/@sqlanvil/cli:worker_bundle",
    ],
    tags = [
        "integration",
        "prd-artifacts",
    ],
    deps = [
        "//:node_modules/@duckdb/node-api",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
        "//:node_modules/long",
        "//cli:index_test_base",
        "//cli/api",
        "//protos:ts",
        "//testing",
    ],
)
