import * as pg from "pg";

import { execSync } from "child_process";
import { sleepUntil } from "sa/common/promises";
import { IHookHandler } from "sa/testing";

const USE_CLOUD_BUILD_NETWORK = !!process.env.USE_CLOUD_BUILD_NETWORK;
const DOCKER_CONTAINER_NAME = "postgres-sa-integration-testing";
const POSTGRES_IMAGE = "postgres:15-alpine";
const POSTGRES_SERVE_PORT = 5432;

// Helper to check bypass dynamically
function isDockerBypassed() {
  return !!process.env.PG_HOST || !!process.env.PG_CONNECTION_STRING;
}

export class PostgresFixture {
  public static get host() {
    return isDockerBypassed()
      ? (process.env.PG_HOST || "localhost")
      : (USE_CLOUD_BUILD_NETWORK ? DOCKER_CONTAINER_NAME : "localhost");
  }

  public static get port() {
    return isDockerBypassed()
      ? (process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432)
      : 5432;
  }

  public static get user() {
    return isDockerBypassed() ? (process.env.PG_USER || "postgres") : "postgres";
  }

  public static get password() {
    return isDockerBypassed() ? (process.env.PG_PASSWORD || "password") : "password";
  }

  public static get database() {
    return isDockerBypassed() ? (process.env.PG_DATABASE || "postgres") : "postgres";
  }

  constructor(port: number, setUp: IHookHandler, tearDown: IHookHandler) {
    setUp("starting postgres", async () => {
      const finalPort = PostgresFixture.port;
      const bypass = isDockerBypassed();

      if (!bypass) {
        execSync(
          [
            "docker run",
            "--rm",
            `--name ${DOCKER_CONTAINER_NAME}`,
            "-e POSTGRES_PASSWORD=password",
            "-d",
            `-p ${finalPort}:${POSTGRES_SERVE_PORT}`,
            USE_CLOUD_BUILD_NETWORK ? "--network cloudbuild" : "",
            POSTGRES_IMAGE
          ].join(" ")
        );
      }

      const pool = new pg.Pool({
        user: PostgresFixture.user,
        password: PostgresFixture.password,
        database: PostgresFixture.database,
        port: finalPort,
        host: PostgresFixture.host
      });

      // Block until postgres is ready to accept requests.
      await sleepUntil(async () => {
        try {
          const client = await pool.connect();
          client.release();
          return true;
        } catch (e) {
          return false;
        }
      }, 500);
    });

    tearDown("stopping postgres", () => {
      if (!isDockerBypassed()) {
        execSync(`docker stop ${DOCKER_CONTAINER_NAME}`);
      }
    });
  }
}
