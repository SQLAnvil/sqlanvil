package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "supabase",
    srcs = glob(
        ["*.ts"],
    ),
    deps = [
        "//testing",
        "//tools/postgres",
        "//:node_modules/@types/node",
    ],
)
