load("//tools:ts_library.bzl", "ts_library")
load("//tools/common:copy.bzl", "copy_file")
load("//testing:index.bzl", "ts_test_suite")
load("//tools:node_modules.bzl", "node_modules")

package(default_visibility = ["//visibility:public"])

ts_library(
    name = "cli",
    srcs = [
        "commands/artifact_views.ts",
        "commands/compile_command.ts",
        "commands/docs_command.ts",
        "commands/format_command.ts",
        "commands/help_command.ts",
        "commands/index.ts",
        "commands/init_command.ts",
        "commands/init_creds_command.ts",
        "commands/inspect_command.ts",
        "commands/install_command.ts",
        "commands/introspect_command.ts",
        "commands/migrate_dataform_command.ts",
        "commands/migrate_fix_command.ts",
        "commands/query_command.ts",
        "commands/run_command.ts",
        "commands/test_command.ts",
        "commands/validate_command.ts",
        "common_options.ts",
        "console.ts",
        "credentials.ts",
        "index.ts",
        "interactive_init.ts",
        "project_config_options.ts",
        "util.ts",
        "yargswrapper.ts",
    ],
    deps = [
        "//cli/api",
        "//cli/vm",
        "//core",
        "//protos:ts",
        "//sqlx:format",
        "@npm//@types/glob",
        "@npm//@types/js-yaml",
        "@npm//@types/long",
        "@npm//@types/node",
        "@npm//@types/readline-sync",
        "@npm//@types/yargs",
        "@npm//chokidar",
        "@npm//glob",
        "@npm//js-yaml",
        "@npm//parse-duration",
        "@npm//readline-sync",
        "@npm//untildify",
        "@npm//yargs",
    ],
)

node_modules(
    name = "node_modules",
    deps = [
        "//packages/@sqlanvil/cli:package_tar",
    ],
)

ts_library(
    name = "index_test_base",
    srcs = ["index_test_base.ts"],
    deps = [
        "//core",
        "//protos:ts",
        "//testing",
        "@npm//@types/fs-extra",
        "@npm//@types/js-yaml",
        "@npm//@types/node",
        "@npm//fs-extra",
        "@npm//js-yaml",
    ],
)

ts_test_suite(
    name = "tests",
    srcs = [
        "index_help_test.ts",
        "index_init_test.ts",
        "index_interactive_init_test.ts",
        "index_project_test.ts",
        "index_compile_test.ts",
        "index_connections_test.ts",
        "index_run_e2e_test.ts",
        "util_test.ts"
    ],
    data = [
        ":node_modules",
        "//packages/@sqlanvil/core:package_tar",
        "@nodejs//:node",
        "@nodejs//:npm",
        "//test_credentials:bigquery.json",
    ],
    deps = [
        ":index_test_base",
        "//cli",
        "//cli/api",
        "//core",
        "//protos:ts",
        "//testing",
        "@npm//@types/chai",
        "@npm//@types/fs-extra",
        "@npm//@types/js-yaml",
        "@npm//@types/long",
        "@npm//@types/node",
        "@npm//chai",
        "@npm//fs-extra",
        "@npm//js-yaml",
        "@npm//ts-mockito",
    ],
)

copy_file(
    name = "readme",
    src = "//:README.md",
    out = "README.md",
)
