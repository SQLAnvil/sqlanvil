load("@aspect_rules_js//js:defs.bzl", "js_binary")
load("//:version.bzl", "SQLANVIL_VERSION")
load("//packages:index.bzl", "add_license_header_to_file", "pkg_bundle", "pkg_json", "pkg_npm_tar")
load("//tools:ts_library.bzl", "ts_library")
load("//tools/common:copy.bzl", "copy_file")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "cli",
    srcs = glob(["*.ts"]),
    deps = [
        "//cli",
        "//cli/api",
        "//protos:ts",
    ],
)

js_binary(
    name = "bin",
    # Only used for local dev; testonly prevents prod targets from depending on it
    testonly = True,
    chdir = "$$BUILD_WORKING_DIRECTORY",
    data = [
        ":cli",
        "//testing:resolver-patch",
    ],
    entry_point = "bin_loader.js",
)

externals = [
    "@duckdb/node-api",
    "@google-cloud/bigquery",
    "chokidar",
    "deepmerge",
    "fs-extra",
    "glob",
    "google-auth-library",
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
    name = "bundle_no_license",
    allow_node_builtins = True,
    entry_point = "index.js",
    externals = bundle_externals,
    deps = [
        ":cli",
    ],
)

add_license_header_to_file(
    name = "bundle",
    from_file = ":bundle_no_license",
    to_file = "bundle.js",
    use_shebang = True,
)

pkg_bundle(
    name = "worker_bundle_no_license",
    allow_node_builtins = True,
    # Compiled cli/vm/worker.ts, the single worker entry point (also used in dev/tests via
    # cli/vm/worker_loader.js).
    entry_point = "//cli/vm:worker.js",
    externals = bundle_externals,
    deps = [
        "//cli/vm",
    ],
)

add_license_header_to_file(
    name = "worker_bundle",
    from_file = ":worker_bundle_no_license",
    to_file = "worker_bundle.js",
    use_shebang = True,
)

copy_file(
    name = "readme",
    src = "//cli:README.md",
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
    publishable = True,
)
