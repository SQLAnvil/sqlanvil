load("//testing:index.bzl", "ts_test_suite")
load("//tools:ts_library.bzl", "ts_library")

package(default_visibility = ["//visibility:public"])

exports_files([
    "README.md",
])

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
        "//:node_modules/@types/glob",
        "//:node_modules/@types/js-yaml",
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/@types/readline-sync",
        "//:node_modules/@types/yargs",
        "//:node_modules/chokidar",
        "//:node_modules/glob",
        "//:node_modules/js-yaml",
        "//:node_modules/parse-duration",
        "//:node_modules/readline-sync",
        "//:node_modules/untildify",
        "//:node_modules/yargs",
    ],
)

ts_library(
    name = "index_test_base",
    srcs = ["index_test_base.ts"],
    deps = [
        "//cli",
        "//core",
        "//protos:ts",
        "//testing",
        "//:node_modules/@types/fs-extra",
        "//:node_modules/@types/js-yaml",
        "//:node_modules/@types/node",
        "//:node_modules/fs-extra",
        "//:node_modules/js-yaml",
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
        "tests/bin_test.ts",
        "util_test.ts"
    ],
    data = [
        "//packages/@sqlanvil/cli:bundle",
        "//packages/@sqlanvil/cli:json",
        "//packages/@sqlanvil/cli:worker_bundle",
        "//packages/@sqlanvil/core:package_tar",
        "//test_credentials:bigquery.json",
    ],
    # index_test_base runs `npm` directly, and the CLI runs `npm i` when sqlanvilCoreVersion is set.
    include_npm = True,
    deps = [
        ":index_test_base",
        "//cli",
        "//cli/api",
        "//core",
        "//protos:ts",
        "//testing",
        "//:node_modules/@types/chai",
        "//:node_modules/@types/fs-extra",
        "//:node_modules/@types/js-yaml",
        "//:node_modules/@types/long",
        "//:node_modules/@types/node",
        "//:node_modules/chai",
        "//:node_modules/fs-extra",
        "//:node_modules/js-yaml",
        "//:node_modules/ts-mockito",
    ],
)
