package(default_visibility = ["//visibility:public"])

load("//tools:ts_library.bzl", "ts_library")

ts_library(
    name = "utils",
    srcs = glob(
        ["**/*.ts"],
        # Postgres helper — relocated from api/utils/ in Phase 2.
        # Excluded until Phase 3 wires it through cli/api's BUILD with
        # the right pg/pg-query-stream deps and an updated import surface.
        exclude = ["postgres.ts"],
    ),
    deps = [
        "//common/protos",
        "//common/strings",
        "//core",
        "//protos:ts",
        "@npm//@types/node",
        "@npm//object-sizeof",
    ],
)
