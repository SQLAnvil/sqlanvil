load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

http_archive(
    name = "build_bazel_rules_nodejs",
    sha256 = "e79c08a488cc5ac40981987d862c7320cee8741122a2649e9b08e850b6f20442",
    urls = ["https://github.com/bazelbuild/rules_nodejs/releases/download/3.8.0/rules_nodejs-3.8.0.tar.gz"],
)

load("@build_bazel_rules_nodejs//:index.bzl", "node_repositories", "yarn_install")

node_repositories(
    node_repositories = {
        "20.20.2-darwin_amd64": ("node-v20.20.2-darwin-x64.tar.xz", "node-v20.20.2-darwin-x64", "4d4c020eb534497e616de38f3733289ff33c615ddab38c048edec6547b7f76ea"),
        "20.20.2-darwin_arm64": ("node-v20.20.2-darwin-arm64.tar.xz", "node-v20.20.2-darwin-arm64", "6375a1d4421bc04ab284ba89459df788a78c49c89e83c463d0eede47e2efc07b"),
        "20.20.2-linux_amd64": ("node-v20.20.2-linux-x64.tar.xz", "node-v20.20.2-linux-x64", "df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d"),
        "20.20.2-linux_arm64": ("node-v20.20.2-linux-arm64.tar.xz", "node-v20.20.2-linux-arm64", "73093db209e4e9e09dd7d15a47aeaab1b74833830df03efa5f942a1122c5fa71"),
        "20.20.2-windows_amd64": ("node-v20.20.2-win-x64.zip", "node-v20.20.2-win-x64", "dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77"),
    },
    node_version = "20.20.2",
    package_json = ["//:package.json"],
    yarn_version = "1.13.0",
)

yarn_install(
    name = "npm",
    package_json = "//:package.json",
    symlink_node_modules = False,
    yarn_lock = "//:yarn.lock",
)
