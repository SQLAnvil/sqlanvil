load("//testing:index.bzl", "ts_test_suite")

package(default_visibility = ["//visibility:public"])

# The release area's integration-level characterization suite (docs/prd/sqlanvil/testing.md,
# Harness, Layout). Binaries are run from the runfiles, never through `bazel run`.
ts_test_suite(
    name = "release",
    srcs = [
        "bundlers.spec.ts",
        "cli_bin.spec.ts",
        "gen_package_json.spec.ts",
        "helpers.ts",
        "known_failing.ts",
        "publish.spec.ts",
        "regenerate_docs.spec.ts",
        "release_github.spec.ts",
        "sample_extension.spec.ts",
        "script_repo.ts",
        "tar.ts",
        "tarballs.spec.ts",
    ],
    # Repository source files (LICENSE, protos, packages/index.bzl, the bundler configs, the
    # scripts) are read from the workspace root that //:version.bzl leads to (helpers.ts).
    data = [
        "//:node_modules/@rollup/plugin-commonjs",
        "//:node_modules/@rollup/plugin-node-resolve",
        "//:node_modules/rollup",
        "//:version.bzl",
        "//packages:gen-package-json-bin",
        "//packages/@sqlanvil/cli:bin",
        "//packages/@sqlanvil/cli:package_tar",
        "//packages/@sqlanvil/core:package.publish",
        "//packages/@sqlanvil/core:package_tar",
        "//packages/sample-extension:package_tar",
    ],
    tags = ["integration"],
    deps = [
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
        "//core",
        "//testing",
    ],
)
