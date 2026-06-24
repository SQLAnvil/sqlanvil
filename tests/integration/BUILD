load("//tools:ts_library.bzl", "ts_library")
load("//testing:index.bzl", "ts_test_suite")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "utils",
    srcs = ["utils.ts"],
    testonly = 1,
    deps = [
        "//cli/api",
        "//core",
        "//protos:ts",
        "@npm//@types/chai",
        "@npm//@types/node",
        "@npm//chai",
    ],
)

ts_test_suite(
    name = "tests",
    srcs = [
        "bigquery.spec.ts",
    ],
    data = [
        "//test_credentials:bigquery.json",
        "//tests/integration/bigquery_project:files",
        "//tests/integration/bigquery_project:node_modules",
    ],
    tags = ["integration"],
    deps = [
        ":utils",
        "//cli/api",
        "//cli/api/utils",
        "//common/promises",
        "//core",
        "//protos:ts",
        "//testing",
        "@npm//@types/chai",
        "@npm//@types/long",
        "@npm//@types/node",
        "@npm//chai",
    ],
)

ts_test_suite(
    name = "postgres_tests",
    srcs = [
        "postgres.spec.ts",
    ],
    data = [
        "//tests/integration/postgres_assertion_project:files",
        "//tests/integration/postgres_assertion_project:node_modules",
        "//tests/integration/postgres_project:files",
        "//tests/integration/postgres_project:node_modules",
    ],
    tags = ["integration"],
    deps = [
        ":utils",
        "//cli/api",
        "//cli/api/utils",
        "//common/promises",
        "//core",
        "//protos:ts",
        "//testing",
        "//tools/postgres",
        "@npm//@types/chai",
        "@npm//@types/long",
        "@npm//@duckdb/node-api",
        "@npm//@types/node",
        "@npm//chai",
    ],
)

ts_test_suite(
    name = "mysql_tests",
    srcs = [
        "mysql.spec.ts",
    ],
    data = [
        "//tests/integration/mysql_project:files",
        "//tests/integration/mysql_project:node_modules",
    ],
    tags = ["integration"],
    deps = [
        ":utils",
        "//cli/api",
        "//cli/api/utils",
        "//common/promises",
        "//core",
        "//protos:ts",
        "//testing",
        "//tools/mysql",
        "@npm//@types/chai",
        "@npm//@types/long",
        "@npm//@types/node",
        "@npm//chai",
    ],
)

ts_test_suite(
    name = "supabase_tests",
    srcs = [
        "supabase.spec.ts",
        "supabase_rls.spec.ts",
    ],
    data = [
        "//tests/integration/supabase_project:files",
        "//tests/integration/supabase_project:node_modules",
        "//tests/integration/supabase_rls_project:files",
        "//tests/integration/supabase_rls_project:node_modules",
    ],
    tags = ["integration"],
    deps = [
        ":utils",
        "//cli/api",
        "//cli/api/utils",
        "//common/promises",
        "//core",
        "//protos:ts",
        "//testing",
        "//tools/supabase",
        "@npm//@types/chai",
        "@npm//@types/long",
        "@npm//@types/node",
        "@npm//@types/pg",
        "@npm//chai",
        "@npm//pg",
    ],
)
