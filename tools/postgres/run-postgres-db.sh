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
echo "You can now run integration tests using standard connection variables:"
echo "  PG_HOST=localhost PG_USER=postgres PG_PASSWORD=password PG_PORT=5432 ./scripts/docker-bazel test //tests/integration:postgres_tests"
echo "  SUPABASE_HOST=localhost SUPABASE_USER=postgres SUPABASE_PASSWORD=password SUPABASE_PORT=5432 ./scripts/docker-bazel test //tests/integration:supabase_tests"
