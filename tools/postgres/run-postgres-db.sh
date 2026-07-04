#!/usr/bin/env bash
# Build and run the custom Postgres + pgvector container for local integration testing.
#
# Usage:
#   ./tools/postgres/run-postgres-db.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="sqlanvil-postgres-test"
CONTAINER_NAME="postgres-sa-integration-testing"

echo "Building custom Postgres + pgvector Docker image..."
docker build -f "$DIR/Dockerfile.postgres" -t "$IMAGE_NAME" "$DIR"

# Stop existing container if running
if [ "$(docker ps -aq -f name="^${CONTAINER_NAME}$")" ]; then
    echo "Stopping existing container..."
    docker rm -f "$CONTAINER_NAME"
fi

echo "Launching Postgres test container on port 5432..."
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=postgres \
  -p 5432:5432 \
  -d \
  "$IMAGE_NAME"

echo "Postgres test container is starting!"
echo ""
echo "Run the integration tests (native bazel; validated 2026-07-04). Notes:"
echo "  - The runnable targets are :postgres.spec / :supabase.spec (the *_tests"
echo "    targets are compile-only ts_test_suite macros)."
echo "  - Bazel sandboxes tests, so the connection env must be passed with --test_env."
echo "  - (Only if running inside ./scripts/docker-bazel: use host.docker.internal"
echo "    instead of 127.0.0.1.)"
echo ""
echo "  PG_HOST=127.0.0.1 PG_PORT=5432 PG_USER=postgres PG_PASSWORD=password PG_DATABASE=postgres \\"
echo "    bazel test //tests/integration:postgres.spec \\"
echo "    --test_env=PG_HOST --test_env=PG_PORT --test_env=PG_USER --test_env=PG_PASSWORD --test_env=PG_DATABASE"
echo ""
echo "  SUPABASE_HOST=127.0.0.1 SUPABASE_PORT=5432 SUPABASE_USER=postgres SUPABASE_PASSWORD=password SUPABASE_DATABASE=postgres \\"
echo "    bazel test //tests/integration:supabase.spec \\"
echo "    --test_env=SUPABASE_HOST --test_env=SUPABASE_PORT --test_env=SUPABASE_USER --test_env=SUPABASE_PASSWORD --test_env=SUPABASE_DATABASE"
