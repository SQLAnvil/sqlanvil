package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")
load("//testing:index.bzl", "ts_test_suite")

ts_library(
    name = "flags",
    srcs = glob(
        ["*.ts"],
        exclude = ["*_test.ts"],
    ),
    deps = [
        "//:modules-fix",
        "@npm//@types/long",
        "@npm//@types/node",
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
        "@npm//@types/chai",
        "@npm//@types/node",
        "@npm//chai",
        "@npm//long",
    ],
)
