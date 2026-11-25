package(default_visibility = ["//visibility:public"])

load("//testing:index.bzl", "ts_test_suite")
load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "utils",
    srcs = glob(
        ["**/*.ts"],
        exclude = ["**/*_test.ts"],
    ),
    deps = [
        "//core",
        "//protos:ts",
        "//:node_modules/@types/node",
        "//:node_modules/@types/pg",
        "//:node_modules/@types/long",
        "//:node_modules/long",
        "//:node_modules/mysql2",
        "//:node_modules/object-sizeof",
        "//:node_modules/pg",
        "//:node_modules/pg-query-stream",
    ],
)

ts_test_suite(
    name = "tests",
    srcs = [
        "dry_run_validation_test.ts",
        "error_parsing_test.ts",
        "query_transforms_test.ts",
    ],
    deps = [
        ":utils",
        "//testing",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
    ],
)
