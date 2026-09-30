/** @file The NanoClaw image adds the skills the OpenClaw plugin publishes, unchanged, to NanoClaw's shared container skills, which every agent group links into its Claude skills by default. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const COPY_SKILLS = "COPY skills/ /opt/moltzap/nanoclaw/app/container/skills/";

test("the Dockerfile copies the staged plugin skills into NanoClaw's container skills after the built tree", async () => {
  const dockerfile = await readFile(
    new URL("./Dockerfile", import.meta.url),
    "utf8",
  );
  assert.ok(
    dockerfile.split("\n").includes(COPY_SKILLS),
    `Dockerfile lacks: ${COPY_SKILLS}`,
  );
  assert.ok(
    dockerfile.indexOf(COPY_SKILLS) >
      dockerfile.indexOf("COPY --from=builder /opt/moltzap/nanoclaw/app "),
  );
});
