#!/usr/bin/env bash
set -euo pipefail
docker rm -f mysql-sa-itest mariadb-sa-itest 2>/dev/null || true
echo "Launching mysql:8 on 3306 and mariadb:11 on 3307..."
docker run --rm --name mysql-sa-itest   -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=sqlanvil -p 3306:3306 -d mysql:8
docker run --rm --name mariadb-sa-itest -e MARIADB_ROOT_PASSWORD=password -e MARIADB_DATABASE=sqlanvil -p 3307:3306 -d mariadb:11
cat <<'NOTE'
Run the integration spec against each engine (reach containers as host.docker.internal):

  # MySQL
  MYSQL_HOST=host.docker.internal MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASSWORD=password MYSQL_DATABASE=sqlanvil \
    ./scripts/docker-bazel test //tests/integration:mysql.spec \
    --test_env=MYSQL_HOST --test_env=MYSQL_PORT --test_env=MYSQL_USER --test_env=MYSQL_PASSWORD --test_env=MYSQL_DATABASE \
    --jobs=2 --local_ram_resources=2048

  # MariaDB (point the same env at port 3307)
  MYSQL_HOST=host.docker.internal MYSQL_PORT=3307 MYSQL_USER=root MYSQL_PASSWORD=password MYSQL_DATABASE=sqlanvil \
    ./scripts/docker-bazel test //tests/integration:mysql.spec \
    --test_env=MYSQL_HOST --test_env=MYSQL_PORT --test_env=MYSQL_USER --test_env=MYSQL_PASSWORD --test_env=MYSQL_DATABASE \
    --jobs=2 --local_ram_resources=2048
NOTE
