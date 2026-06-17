load("//tools:ts_library.bzl", "ts_library")
load("//:version.bzl", "SQLANVIL_VERSION")
load("//packages:index.bzl", "LICENSE_HEADER", "add_license_header_to_file", "pkg_bundle", "pkg_json", "pkg_npm_tar")
load("//tools/common:copy.bzl", "copy_file")
load("@build_bazel_rules_nodejs//:index.bzl", "nodejs_binary")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "cli",
    srcs = glob(["*.ts"]),
    deps = [
        "//cli",
        "//cli/vm:compile_loader",
    ],
)

nodejs_binary(
    name = "bin",
    data = [
        ":cli",
        "@npm//source-map-support",
    ],
    entry_point = ":index.ts",
    templated_args = [
        "--node_options=--require=source-map-support/register",
        "--bazel_patch_module_resolver",
    ],
)

externals = [
    "@google-cloud/bigquery",
    "chokidar",
    "deepmerge",
    "fs-extra",
    "glob",
    "google-sql-syntax-ts",
    "js-beautify",
    "js-yaml",
    "moo",
    "mysql2",
    "object-sizeof",
    "parse-duration",
    "pg",
    "pg-query-stream",
    "promise-pool-executor",
    "protobufjs",
    "readline-sync",
    "semver",
    "tarjan-graph",
    "tmp",
    "typeid-js",
    "untildify",
    "vm2",
    "yargs",
]

# Rollup matches import specifiers exactly, so the mysql2 promise subpath must be
# listed too (the adapter imports "mysql2/promise"); package.json only carries the
# real package name "mysql2".
bundle_externals = externals + ["mysql2/promise"]

pkg_json(
    name = "json",
    package_name = "@sqlanvil/cli",
    description = "sqlanvil command line interface.",
    external_deps = externals,
    layers = [
        "//:package.json",
        "//packages/@sqlanvil:package.layer.json",
        "//packages/@sqlanvil/cli:package.layer.json",
    ],
    main = "bundle.js",
    version = SQLANVIL_VERSION,
)

pkg_bundle(
    name = "bundle",
    allow_node_builtins = True,
    args = ["--banner='#!/usr/bin/env node\n" + LICENSE_HEADER + "'"],
    entry_point = "index.ts",
    externals = bundle_externals,
    deps = [
        ":cli",
    ],
)

pkg_bundle(
    name = "worker_bundle",
    allow_node_builtins = True,
    args = ["--banner='#!/usr/bin/env node\n" + LICENSE_HEADER + "'"],
    entry_point = "worker.ts",
    externals = bundle_externals,
    deps = [
        ":cli",
    ],
)

copy_file(
    name = "readme",
    src = "//:README.md",
    out = "README.md",
)

copy_file(
    name = "license",
    src = "//:LICENSE",
    out = "LICENSE",
)

copy_file(
    name = "notice",
    src = "//:NOTICE",
    out = "NOTICE",
)

pkg_npm_tar(
    name = "package",
    deps = [
        ":bundle",
        ":license",
        ":notice",
        ":package.json",
        ":readme",
        ":worker_bundle",
    ],
)
