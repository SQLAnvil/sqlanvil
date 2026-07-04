#!/usr/bin/env bash
# Boot a full local Supabase stack (Postgres + GoTrue + PostgREST + Realtime +
# Studio) via the Supabase CLI, for high-fidelity RLS / auth / realtime testing.
#
# This is the Tier-2 fixture: the bare-Postgres container from
# ../postgres/run-postgres-db.sh is enough for SQL-generation correctness, but
# only a real Supabase stack has the genuine anon/authenticated/service_role
# roles, auth schema + auth.uid(), and Realtime service. The RLS enforcement
# spec (tests/integration/supabase_rls.spec.ts) runs against either — it seeds
# the auth primitives itself when they're absent — but this stack exercises the
# real ones.
#
# Requires: supabase CLI (brew install supabase/tap/supabase) + Docker.
#
# Usage:
#   ./tools/supabase/run-supabase-stack.sh         # start
#   ./tools/supabase/run-supabase-stack.sh stop    # stop

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$DIR/.supabase-stack"   # gitignored; holds supabase/config.toml + state

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found. Install: brew install supabase/tap/supabase" >&2
  exit 1
fi

mkdir -p "$WORKDIR"
if [ ! -f "$WORKDIR/supabase/config.toml" ]; then
  echo "Initializing local Supabase project in $WORKDIR ..."
  ( cd "$WORKDIR" && supabase init )
fi

if [ "${1:-start}" = "stop" ]; then
  ( cd "$WORKDIR" && supabase stop )
  exit 0
fi

( cd "$WORKDIR" && supabase start )

cat <<'EOF'

Local Supabase stack is up. The Postgres DB is exposed on port 54322
(user: postgres, password: postgres, db: postgres).

Run the RLS enforcement spec against it (native bazel; pass env with --test_env).
(Only if running inside ./scripts/docker-bazel: use host.docker.internal instead.)

  SUPABASE_HOST=127.0.0.1 SUPABASE_PORT=54322 SUPABASE_USER=postgres SUPABASE_PASSWORD=postgres SUPABASE_DATABASE=postgres \
    bazel test //tests/integration:supabase_rls.spec \
    --test_env=SUPABASE_HOST --test_env=SUPABASE_PORT --test_env=SUPABASE_USER --test_env=SUPABASE_PASSWORD --test_env=SUPABASE_DATABASE

Stop the stack with: ./tools/supabase/run-supabase-stack.sh stop
EOF
