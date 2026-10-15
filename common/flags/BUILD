package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")
load("//testing:index.bzl", "ts_test_suite")

ts_library(
    name = "flags",
    srcs = glob(
        ["*.ts"],
        exclude = ["*_test.ts", "*.spec.ts"],
    ),
    deps = [
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/long",
    ],
)

load("//testing:build_test.bzl", "build_test")

build_test(
    name = "build_test",
    deps = [":flags"],
)

ts_test_suite(
    name = "tests",
    srcs = ["index_test.ts"],
    deps = [
        ":flags",
        "//testing",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
        "//:node_modules/long",
    ],
)
