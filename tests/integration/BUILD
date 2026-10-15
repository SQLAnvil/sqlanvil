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
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
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
        "//:node_modules/@types/chai",
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
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
        "//tests/integration/postgres_options_project:files",
        "//tests/integration/postgres_options_project:node_modules",
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
        "//:node_modules/@types/chai",
        "//:node_modules/@types/long",
        "//:node_modules/@duckdb/node-api",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
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
        "//tests/integration/mysql_options_project:files",
        "//tests/integration/mysql_options_project:node_modules",
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
        "//:node_modules/@types/chai",
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
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
        "//:node_modules/@types/chai",
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/@types/pg",
        "//:node_modules/chai",
        "//:node_modules/pg",
    ],
)
