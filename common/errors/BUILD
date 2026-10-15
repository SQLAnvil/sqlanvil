load("//testing:index.bzl", "ts_test_suite")
load("//tools:ts_library.bzl", "ts_library")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "errors",
    srcs = glob(
        ["*.ts"],
        exclude = ["*.spec.ts"],
    ),
    deps = [
    ],
)

ts_test_suite(
    name = "tests",
    srcs = glob(["*.spec.ts"]),
    deps = [
        ":errors",
        "//testing",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
    ],
)
