#!/bin/bash
# Build the camelCase-capable protoc-gen-doc image used by scripts/regenerate_docs.
# Clones the Ekrekr/protoc-gen-doc fork at the pinned camelCase commit and builds
# it with tools/protoc-gen-doc/Dockerfile. Tags the result protoc-gen-doc:camelcase.
set -euo pipefail

IMAGE="${PROTOC_GEN_DOC_IMAGE:-protoc-gen-doc:camelcase}"
FORK_REPO="https://github.com/Ekrekr/protoc-gen-doc.git"
FORK_REF="899147b0ecf110b16d8f42951199bbfa7304ae8b"  # add-camel-case-option (PR #540)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning protoc-gen-doc fork (camelCase branch)..."
git clone --quiet "$FORK_REPO" "$WORK/src"
git -C "$WORK/src" fetch --quiet --depth 1 origin "$FORK_REF"
git -C "$WORK/src" checkout --quiet "$FORK_REF"

cp "$SCRIPT_DIR/Dockerfile" "$WORK/src/Dockerfile.camelcase"

echo "Building $IMAGE ..."
docker build -f "$WORK/src/Dockerfile.camelcase" -t "$IMAGE" "$WORK/src"
echo "Done: $IMAGE"
