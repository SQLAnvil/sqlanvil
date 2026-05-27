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
        "@npm//@types/node",
        "@npm//@types/pg",
        "@npm//@types/uuid",
        "@npm//pg",
        "@npm//promise-pool-executor",
        "@npm//uuid",
    ],
)
