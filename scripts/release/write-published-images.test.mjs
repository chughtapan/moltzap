/** @file Tests for the published-images table writer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodePublishedImages,
  renderPublishedImages,
  replacePublishedImagesSection,
} from "./write-published-images.mjs";

const REPOSITORY = "us-central1-docker.pkg.dev/example/moltzap-simulator";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const REVISION = "0123456789abcdef0123456789abcdef01234567";

const fixture = () => ({
  version: "2026.902.0",
  sourceRevision: REVISION,
  images: [
    {
      name: "nanoclaw-agent",
      repository: `${REPOSITORY}/nanoclaw-agent`,
      digest: DIGEST_C,
    },
    {
      name: "controller",
      repository: `${REPOSITORY}/controller`,
      digest: DIGEST_A,
    },
    {
      name: "openclaw-agent",
      repository: `${REPOSITORY}/openclaw-agent`,
      digest: DIGEST_B,
    },
  ],
});

const README = [
  "# GKE profile",
  "",
  "## Published images",
  "",
  "No release has published images yet.",
  "",
  "## Qualification",
  "",
  "Later text.",
  "",
].join("\n");

test("renders one row per image in fixed order with digest references", () => {
  const body = renderPublishedImages(decodePublishedImages(fixture()));
  assert.equal(
    body,
    [
      "Release `2026.902.0` (source revision",
      `\`${REVISION}\`) pushed these images. Pin a run to the digest`,
      "reference; the tag is a lookup key, not an input the profile accepts.",
      "",
      "| Image | Tag | Digest reference |",
      "| --- | --- | --- |",
      `| controller | \`2026.902.0\` | \`${REPOSITORY}/controller@${DIGEST_A}\` |`,
      `| openclaw-agent | \`2026.902.0\` | \`${REPOSITORY}/openclaw-agent@${DIGEST_B}\` |`,
      `| nanoclaw-agent | \`2026.902.0\` | \`${REPOSITORY}/nanoclaw-agent@${DIGEST_C}\` |`,
      "",
    ].join("\n"),
  );
});

test("replaces only the section body and keeps the surrounding document", () => {
  const updated = replacePublishedImagesSection(README, "New body.\n");
  assert.equal(
    updated,
    [
      "# GKE profile",
      "",
      "## Published images",
      "",
      "New body.",
      "",
      "## Qualification",
      "",
      "Later text.",
      "",
    ].join("\n"),
  );
  assert.equal(
    replacePublishedImagesSection(updated, "New body.\n"),
    updated,
    "a second write with the same body is a no-op",
  );
});

test("writes to the end of the document when the section is last", () => {
  const markdown = "# Title\n\n## Published images\n\nold\n";
  assert.equal(
    replacePublishedImagesSection(markdown, "new\n"),
    "# Title\n\n## Published images\n\nnew\n",
  );
});

test("refuses a README without the section", () => {
  assert.throws(
    () => replacePublishedImagesSection("# Title\n", "body\n"),
    /no "## Published images" section/u,
  );
});

test("refuses a missing, duplicate, unknown, or malformed image", () => {
  const missing = fixture();
  missing.images.pop();
  assert.throws(
    () => decodePublishedImages(missing),
    /missing openclaw-agent/u,
  );

  const duplicate = fixture();
  duplicate.images.push(duplicate.images[1]);
  assert.throws(() => decodePublishedImages(duplicate), /listed twice/u);

  const unknown = fixture();
  unknown.images[0] = { ...unknown.images[0], name: "support" };
  assert.throws(() => decodePublishedImages(unknown), /unknown image name/u);

  const tagged = fixture();
  tagged.images[1] = {
    ...tagged.images[1],
    repository: `${REPOSITORY}/controller:2026.902.0`,
  };
  assert.throws(() => decodePublishedImages(tagged), /must not carry a tag/u);

  const badDigest = fixture();
  badDigest.images[1] = { ...badDigest.images[1], digest: "sha256:short" };
  assert.throws(() => decodePublishedImages(badDigest), /digest must be/u);

  assert.throws(
    () => decodePublishedImages({ ...fixture(), version: "1.2.3" }),
    /version must be/u,
  );
  assert.throws(
    () => decodePublishedImages({ ...fixture(), sourceRevision: "abc" }),
    /sourceRevision must be/u,
  );
});
