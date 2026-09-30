/** @file The NanoClaw image adds the skills the OpenClaw plugin publishes, unchanged, to NanoClaw's shared container skills, which every agent group links into its Claude skills by default. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const COPY_SKILLS = "COPY skills/ /opt/moltzap/nanoclaw/app/container/skills/";
const COPY_BUILT_TREE =
  "COPY --from=builder /opt/moltzap/nanoclaw/app /opt/moltzap/nanoclaw/app";

test("the Dockerfile copies the staged plugin skills into NanoClaw's container skills after the built tree", async () => {
  const lines = (
    await readFile(new URL("./Dockerfile", import.meta.url), "utf8")
  ).split("\n");
  const builtTree = lines.indexOf(COPY_BUILT_TREE);
  const skills = lines.indexOf(COPY_SKILLS);
  assert.ok(builtTree >= 0, `Dockerfile lacks: ${COPY_BUILT_TREE}`);
  assert.ok(skills >= 0, `Dockerfile lacks: ${COPY_SKILLS}`);
  assert.ok(skills > builtTree, "the built tree would replace the skills");
});
