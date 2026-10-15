package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")
load("//testing:index.bzl", "ts_test_suite")

ts_library(
    name = "protos",
    srcs = glob(
        ["*.ts"],
        exclude = ["*_test.ts", "*.spec.ts"],
    ),
    deps = [
        "//common/strings",
        "//protos:ts",
        "//:node_modules/@types/node",
        "//:node_modules/protobufjs",
    ],
)

ts_test_suite(
    name = "tests",
    srcs = glob(["*_test.ts"]),
    deps = [
        ":protos",
        "//protos:ts",
        "//testing",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
    ],
)

load("//testing:build_test.bzl", "build_test")

build_test(
    name = "build_test",
    deps = [":protos"],
)
