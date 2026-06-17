package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "mysql",
    srcs = glob(["*.ts"]),
    deps = [
        "//common/promises",
        "//testing",
        "@npm//@types/node",
        "@npm//mysql2",
    ],
)
