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
        "@npm//@types/node",
        "@npm//@types/pg",
        "@npm//mysql2",
        "@npm//object-sizeof",
        "@npm//pg",
        "@npm//pg-query-stream",
    ],
)
