import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Either, Schema } from "effect";
import { image } from "../dist/agents.js";
import {
  NANOCLAW_SOURCE_REVISION,
  pinnedImageReference,
} from "../scripts/build-nanoclaw-image.mjs";

const imageRoot = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(imageRoot, path), "utf8");
const decodeImage = Schema.decodeUnknownEither(image);
const DIGEST = `sha256:${"a".repeat(64)}`;

// The evaluation CLI rejects anything this schema rejects, and it is the same
// schema value both sides read, so a producer that satisfies it here cannot
// print a reference the sweep then refuses.
test("the produced reference is what the evaluation image schema accepts", () => {
  for (const repository of [
    "moltzap-simulator-nanoclaw",
    "us-central1-docker.pkg.dev/project/repository/nanoclaw",
  ]) {
    const reference = pinnedImageReference(repository, DIGEST);
    assert.equal(reference, `${repository}@${DIGEST}`);
    assert.ok(Either.isRight(decodeImage(reference)));
  }

  assert.ok(Either.isLeft(decodeImage("moltzap-simulator-nanoclaw:latest")));
  assert.throws(() =>
    pinnedImageReference("moltzap-simulator-nanoclaw", "sha256:NOTADIGEST"),
  );
  assert.throws(() =>
    pinnedImageReference(`moltzap-simulator-nanoclaw@${DIGEST}`, DIGEST),
  );
});

test("the build pins its NanoClaw source and prints a digest identity", async () => {
  const script = await read("../scripts/build-nanoclaw-image.mjs");

  assert.match(NANOCLAW_SOURCE_REVISION, /^[0-9a-f]{40}$/);
  assert.match(script, /github\.com\/nanocoai\/nanoclaw\/archive\//);
  assert.match(script, /--metadata-file/);
  assert.match(script, /containerimage\.digest/);
  assert.match(script, /pinnedImage: pinnedImageReference\(/);
  // A mutable tag would make the printed identity unusable as an evaluation
  // input, so the repository argument may not already carry a digest.
  assert.match(script, /repository\.includes\("@"\)/);
});

test("the image satisfies the NanoClaw container runtime contract", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    read("Dockerfile"),
    read("entrypoint.mjs"),
  ]);

  // Exactly the contract src/agents/nanoclaw/runtime.ts renders: the process
  // it starts, the config it mounts, the directory it hands over, and the port
  // the controller's bridge dials.
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node", "\/opt\/moltzap\/nanoclaw\/entrypoint\.mjs"\]/,
  );
  assert.match(dockerfile, /\/var\/lib\/moltzap\/nanoclaw/);
  assert.match(entrypoint, /"moltzap\.nanoclaw-application\/v1"/);
  assert.match(entrypoint, /MOLTZAP_NANOCLAW_CONFIG/);
  assert.match(entrypoint, /MOLTZAP_NANOCLAW_STATE/);
  assert.match(entrypoint, /config\.gateway/);
  assert.match(
    entrypoint,
    /dist\/moltzap-eval-provision\.js|"moltzap-eval-provision\.js"/,
  );
  assert.match(entrypoint, /cli\.sock/);
  // An MCP server may be stdio or streamable HTTP, and the entrypoint owns
  // neither shape: rebuilding one here would drop the other's only field.
  assert.match(entrypoint, /\{ name, \.\.\.definition \}/);

  // Every layer this image is assembled from is immutable.
  const bases = dockerfile.match(/^(?:FROM|COPY --from=)\S*[^\n]*$/gmu) ?? [];
  const remote = bases.filter((line) => !/--from=nanoclaw\b/u.test(line));
  assert.ok(remote.length >= 3);
  for (const line of remote) {
    assert.match(line, /@sha256:[0-9a-f]{64}/);
  }
});
