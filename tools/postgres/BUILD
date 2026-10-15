package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "postgres",
    srcs = glob(
        ["*.ts"],
    ),
    deps = [
        "//common/promises",
        "//testing",
        "//:node_modules/@types/node",
        "//:node_modules/@types/pg",
        "//:node_modules/pg",
        "//:node_modules/promise-pool-executor",
    ],
)
