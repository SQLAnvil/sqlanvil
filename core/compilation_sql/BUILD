load("//tools:ts_library.bzl", "ts_library")
load("//testing:index.bzl", "ts_test_suite")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "compilation_sql",
    srcs = [
        "index.ts",
    ],
    deps = [
        "//protos:ts",
    ]
)

ts_test_suite(
    name = "tests",
    srcs = [
        "compilation_sql_test.ts",
    ],
    data = [
        "//core:node_modules",
    ],
    deps = [
        ":compilation_sql",
        "//protos:ts",
        "//testing",
        "@npm//@types/chai",
        "@npm//chai",
    ]
)

