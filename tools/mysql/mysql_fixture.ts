import { execSync } from "child_process";
import * as mysql from "mysql2/promise";

import { sleepUntil } from "sa/common/promises";
import { IHookHandler } from "sa/testing";

const USE_CLOUD_BUILD_NETWORK = !!process.env.USE_CLOUD_BUILD_NETWORK;
const DOCKER_CONTAINER_NAME = "mysql-sa-integration-testing";
const MYSQL_IMAGE = "mysql:8";
const MYSQL_SERVE_PORT = 3306;

// When MYSQL_HOST is set (the docker-bazel path), the fixture connects to a
// host-provided endpoint instead of booting its own container — exactly like
// PostgresFixture's bypass. This is also how the same class serves both MySQL
// (port 3306) and MariaDB (port 3307): engine/port come from env.
function isDockerBypassed() {
  return !!process.env.MYSQL_HOST;
}

export class MysqlFixture {
  public static get host() {
    return isDockerBypassed()
      ? process.env.MYSQL_HOST || "localhost"
      : USE_CLOUD_BUILD_NETWORK
      ? DOCKER_CONTAINER_NAME
      : "localhost";
  }

  public static get port() {
    return isDockerBypassed()
      ? process.env.MYSQL_PORT
        ? parseInt(process.env.MYSQL_PORT, 10)
        : 3306
      : 3306;
  }

  public static get user() {
    return isDockerBypassed() ? process.env.MYSQL_USER || "root" : "root";
  }

  public static get password() {
    return isDockerBypassed() ? process.env.MYSQL_PASSWORD || "password" : "password";
  }

  public static get database() {
    return isDockerBypassed() ? process.env.MYSQL_DATABASE || "sqlanvil" : "sqlanvil";
  }

  constructor(setUp: IHookHandler, tearDown: IHookHandler) {
    setUp("starting mysql", async () => {
      const bypass = isDockerBypassed();

      if (!bypass) {
        execSync(
          [
            "docker run",
            "--rm",
            `--name ${DOCKER_CONTAINER_NAME}`,
            "-e MYSQL_ROOT_PASSWORD=password",
            "-e MYSQL_DATABASE=sqlanvil",
            "-d",
            `-p ${MysqlFixture.port}:${MYSQL_SERVE_PORT}`,
            USE_CLOUD_BUILD_NETWORK ? "--network cloudbuild" : "",
            MYSQL_IMAGE
          ].join(" ")
        );
      }

      // Block until mysql is ready to accept connections (the server takes a few
      // seconds to initialize even after the container is up).
      await sleepUntil(async () => {
        let conn: mysql.Connection | undefined;
        try {
          conn = await mysql.createConnection({
            host: MysqlFixture.host,
            port: MysqlFixture.port,
            user: MysqlFixture.user,
            password: MysqlFixture.password
          });
          await conn.query("select 1");
          return true;
        } catch (e) {
          return false;
        } finally {
          if (conn) {
            await conn.end().catch(() => undefined);
          }
        }
      }, 500);
    });

    tearDown("stopping mysql", () => {
      if (!isDockerBypassed()) {
        execSync(`docker stop ${DOCKER_CONTAINER_NAME}`);
      }
    });
  }
}
