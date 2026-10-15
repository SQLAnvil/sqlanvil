package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "utils",
    srcs = glob(["**/*.ts"]),
    deps = [
        "//common/protos",
        "//common/strings",
        "//core",
        "//protos:ts",
        "//:node_modules/@types/node",
        "//:node_modules/@types/pg",
        "//:node_modules/mysql2",
        "//:node_modules/object-sizeof",
        "//:node_modules/pg",
        "//:node_modules/pg-query-stream",
    ],
)
