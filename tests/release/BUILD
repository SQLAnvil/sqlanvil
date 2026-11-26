load("//testing:index.bzl", "ts_test_suite")

package(default_visibility = ["//visibility:public"])

# The regenerate_docs success paths (FR-041), in the warehouse level: they need Docker and the
# network for typedoc's npm install (docs/prd/sqlanvil/testing.md, Harness, Layout).
ts_test_suite(
    name = "release",
    srcs = [
        "docs_helpers.ts",
        "front_matter.spec.ts",
        "image_build.spec.ts",
        "missing_page.spec.ts",
        "no_front_matter.spec.ts",
        "pages.spec.ts",
    ],
    data = [
        "//:version.bzl",
        "//core:version",
        "//protos:ts",
    ],
    # A warehouse release case waits at most 30 minutes (testing.md, Harness, Waits).
    tags = [
        "integration",
        "no-sandbox",
        "requires-network",
    ],
    timeout = "eternal",
    deps = [
        "//:node_modules/@types/chai",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
        "//testing",
    ],
)
