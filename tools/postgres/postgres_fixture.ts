import { execSync } from "child_process";
import * as pg from "pg";

import { sleepUntil } from "sa/common/promises";
import { IHookHandler } from "sa/testing";

const USE_CLOUD_BUILD_NETWORK = !!process.env.USE_CLOUD_BUILD_NETWORK;
const DOCKER_CONTAINER_NAME_PREFIX = "postgres-sa-integration-testing";
// Postgres 15 with pgvector preinstalled: the Supabase specs create the `vector` extension.
const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg15";
const POSTGRES_SERVE_PORT = 5432;

// Helper to check bypass dynamically
function isDockerBypassed() {
  return !!process.env.PG_HOST || !!process.env.PG_CONNECTION_STRING;
}

// Each spec passes its own host port, and each spec runs in its own process with one fixture,
// so the container name and host port are per-spec and specs can run in parallel.
let hostPort = POSTGRES_SERVE_PORT;

function containerName() {
  return `${DOCKER_CONTAINER_NAME_PREFIX}-${hostPort}`;
}

export class PostgresFixture {
  public static get host() {
    return isDockerBypassed()
      ? process.env.PG_HOST || "localhost"
      : USE_CLOUD_BUILD_NETWORK
        ? containerName()
        : "localhost";
  }

  public static get port() {
    return isDockerBypassed()
      ? process.env.PG_PORT
        ? parseInt(process.env.PG_PORT, 10)
        : 5432
      : USE_CLOUD_BUILD_NETWORK
        ? POSTGRES_SERVE_PORT
        : hostPort;
  }

  public static get user() {
    return isDockerBypassed() ? process.env.PG_USER || "postgres" : "postgres";
  }

  public static get password() {
    return isDockerBypassed() ? process.env.PG_PASSWORD || "password" : "password";
  }

  public static get database() {
    return isDockerBypassed() ? process.env.PG_DATABASE || "postgres" : "postgres";
  }

  constructor(port: number, setUp: IHookHandler, tearDown: IHookHandler) {
    hostPort = port;

    setUp("starting postgres", async () => {
      if (!isDockerBypassed()) {
        // A container left behind by a killed run would otherwise fail `docker run` on the name.
        execSync(`docker rm -f ${containerName()} || true`, { stdio: "ignore" });
        execSync(
          [
            "docker run",
            "--rm",
            `--name ${containerName()}`,
            "-e POSTGRES_PASSWORD=password",
            "-d",
            `-p ${hostPort}:${POSTGRES_SERVE_PORT}`,
            USE_CLOUD_BUILD_NETWORK ? "--network cloudbuild" : "",
            POSTGRES_IMAGE,
          ].join(" "),
        );
      }

      const pool = new pg.Pool({
        user: PostgresFixture.user,
        password: PostgresFixture.password,
        database: PostgresFixture.database,
        port: PostgresFixture.port,
        host: PostgresFixture.host,
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
      await pool.end();
    });

    tearDown("stopping postgres", () => {
      if (!isDockerBypassed()) {
        execSync(`docker stop ${containerName()}`);
      }
    });
  }
}
