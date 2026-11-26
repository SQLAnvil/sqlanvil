// FR-041 AC-041.5 (test-cases/release.yaml T-041.5).

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { suite, test } from "sa/testing";
import { DOCS_TIMEOUT_MILLIS, env, makeDocsRepo, regenerate, run, withTemp } from "./docs_helpers";

const IMAGE = "sqlanvil-prd-test-protoc-gen-doc:absent";

async function imagePresent(): Promise<boolean> {
  const r = await run("docker", ["image", "inspect", IMAGE], { env: env() });
  return r.exitCode === 0;
}

async function removeImage() {
  await run("docker", ["image", "rm", "-f", IMAGE], { env: env() });
}

suite("release regenerate_docs image build", () => {
  test(
    "@prd T-041.5 a missing protoc-gen-doc image is built before configs.md",
    { timeout: DOCS_TIMEOUT_MILLIS },
    async () => {
      await withTemp(async (T) => {
        if (await imagePresent()) {
          await removeImage();
        }
        expect(await imagePresent(), `${IMAGE} is not present before the run`).equals(false);
        try {
          const docs = makeDocsRepo(T);
          const r = await regenerate(docs, { PROTOC_GEN_DOC_IMAGE: IMAGE });
          expect(r.stdout, r.stderr).to.include(`Image ${IMAGE} not found — building it...`);
          expect(await imagePresent(), `the image ${IMAGE} exists after the run`).equals(true);
          expect(
            fs.existsSync(path.join(docs.reference, "configs.md")),
            "configs.md exists",
          ).equals(true);
        } finally {
          await removeImage();
        }
      });
    },
  );
});
