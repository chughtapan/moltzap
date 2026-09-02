/** @file Tests for the shared image-build helpers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildxDriver,
  metadataDigest,
  parseImageBuildArguments,
} from "./build.mjs";

const builder = {
  script: "x.mjs",
  label: "X image",
  defaultRepository: "moltzap-x",
};

test("defaults to the builder repository, no tag, load mode", () => {
  assert.deepEqual(parseImageBuildArguments([], builder), {
    repository: "moltzap-x",
    tag: undefined,
    push: false,
  });
});

test("accepts --repository, --tag, and --push together", () => {
  assert.deepEqual(
    parseImageBuildArguments(
      ["--repository", "r/x", "--tag", "2026.902.0", "--push"],
      builder,
    ),
    { repository: "r/x", tag: "2026.902.0", push: true },
  );
});

test("rejects an empty, digest-bearing, or tagged repository", () => {
  for (const repository of ["", "r@sha256:abc", "r/x:tagged"]) {
    assert.throws(
      () => parseImageBuildArguments(["--repository", repository], builder),
      /X image repository must not be empty or carry a tag or digest/u,
    );
  }
  assert.equal(
    parseImageBuildArguments(["--repository", "host:5000/r/x"], builder)
      .repository,
    "host:5000/r/x",
    "a registry port is not a tag",
  );
});

test("rejects an invalid tag and unknown or positional arguments", () => {
  for (const tag of ["bad tag", ".leading", "a".repeat(129)]) {
    assert.throws(
      () => parseImageBuildArguments(["--tag", tag], builder),
      /X image tag must be a valid Docker tag/u,
    );
  }
  for (const args of [
    ["--bogus"],
    ["positional"],
    ["--tag"],
    ["--repository"],
  ]) {
    assert.throws(
      () => parseImageBuildArguments(args, builder),
      /usage: x\.mjs \[--repository NAME\] \[--tag TAG\] \[--push\]/u,
    );
  }
});

test("metadataDigest requires a sha256 containerimage.digest", () => {
  const digest = `sha256:${"f".repeat(64)}`;
  assert.equal(metadataDigest({ "containerimage.digest": digest }), digest);
  assert.throws(() => metadataDigest({}), /no manifest digest/u);
  assert.throws(
    () => metadataDigest({ "containerimage.digest": "sha256:short" }),
    /no manifest digest/u,
  );
});

test("reads the driver from buildx inspect output", () => {
  assert.equal(
    buildxDriver("Name:          default\nDriver:        docker\n\nNodes:\n"),
    "docker",
  );
  assert.equal(
    buildxDriver(
      "Name:   builder0\nDriver: docker-container\nLast Activity: x\n",
    ),
    "docker-container",
  );
});

test("rejects inspect output without a driver line", () => {
  assert.throws(() => buildxDriver("Name: default\n"), {
    message: "docker buildx inspect reported no driver",
  });
});
