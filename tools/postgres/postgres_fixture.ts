import * as pg from "pg";

import { execSync } from "child_process";
import { sleepUntil } from "sa/common/promises";
import { IHookHandler } from "sa/testing";

const USE_CLOUD_BUILD_NETWORK = !!process.env.USE_CLOUD_BUILD_NETWORK;
const DOCKER_CONTAINER_NAME = "postgres-sa-integration-testing";
const POSTGRES_IMAGE = "postgres:15-alpine";
const POSTGRES_SERVE_PORT = 5432;

export class PostgresFixture {
  public static readonly host = USE_CLOUD_BUILD_NETWORK ? DOCKER_CONTAINER_NAME : "localhost";

  constructor(port: number, setUp: IHookHandler, tearDown: IHookHandler) {
    setUp("starting postgres", async () => {
      execSync(
        [
          "docker run",
          "--rm",
          `--name ${DOCKER_CONTAINER_NAME}`,
          "-e POSTGRES_PASSWORD=password",
          "-d",
          `-p ${port}:${POSTGRES_SERVE_PORT}`,
          USE_CLOUD_BUILD_NETWORK ? "--network cloudbuild" : "",
          POSTGRES_IMAGE
        ].join(" ")
      );

      const pool = new pg.Pool({
        user: "postgres",
        password: "password",
        database: "postgres",
        port,
        host: PostgresFixture.host
      });

      // Block until postgres is ready to accept requests.
      await sleepUntil(async () => {
        try {
          await pool.connect();
          return true;
        } catch (e) {
          return false;
        }
      }, 500);
    });

    tearDown("stopping postgres", () => {
      execSync(`docker stop ${DOCKER_CONTAINER_NAME}`);
    });
  }
}
