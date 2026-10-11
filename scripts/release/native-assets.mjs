/** @file Publish the private native archive beside its exact Client release, without another npm product. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = /^\d{4}\.\d{3,4}\.\d+$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const LIMIT = 8 * 1024 * 1024;

/**
 * The asset pair is obligatory only when this module exists in the release
 * tree. Legacy npm-only tags therefore remain resumable without invented
 * native artifacts. Commands use Node built-ins only: no dependency execution
 * receives the late-minted release App token.
 * @param {string} version Exact Client calendar release.
 * @returns {string[]} Archive and digest sidecar names.
 */
export function nativeAssetNames(version) {
  assert.match(version, VERSION, "native assets require a calendar version");
  const archive = `moltzap-native-plugins-${version}.tgz`;
  return [archive, `${archive}.sha256`];
}

/**
 * Check actual downloaded bytes, not merely asset names. A missing or partial
 * pair returns false; malformed or conflicting uploaded bytes fail explicitly.
 * Only a 404 is absence, never an authentication or server failure.
 * @param {string} repository Owner/repository.
 * @param {string} version Exact Client release.
 * @param {string|undefined} token Read-only workflow token, if needed.
 * @param {typeof fetch} fetcher Test seam; production uses the fixed GitHub API.
 * @returns {Promise<boolean>} Whether both assets are complete and consistent.
 */
export async function nativeAssetsComplete(
  repository,
  version,
  token,
  fetcher = fetch,
) {
  const names = nativeAssetNames(version);
  const release = await findRelease(repository, version, token, fetcher);
  if (release === undefined) return false;
  const assets = selectAssets(release, names);
  if (assets.some((asset) => asset === undefined)) return false;
  const archive = await download(repository, assets[0].id, token, fetcher);
  const checksum = await download(
    repository,
    assets[1].id,
    token,
    fetcher,
    256,
  );
  verifyPair(names[0], archive, checksum);
  return true;
}

/**
 * Preserve matching assets on retry. Check every existing asset before any
 * upload; never delete, replace, or clobber a conflicting archive or checksum.
 * The tag must already have been committed and pushed by the release workflow.
 * @param {string} repository Owner/repository.
 * @param {string} version Exact Client release.
 * @param {string} directory Gated artifact directory.
 * @param {string} token Existing contents-write release App token.
 * @param {typeof fetch} fetcher Isolated HTTP test seam.
 * @returns {Promise<void>} Both assets are present with exactly the gated bytes.
 */
export async function uploadNativeAssets(
  repository,
  version,
  directory,
  token,
  fetcher = fetch,
) {
  assert.ok(
    token,
    "native release upload requires the existing release App token",
  );
  const names = nativeAssetNames(version);
  const bytes = await localPair(version, directory);
  const release = await ensureRelease(repository, version, token, fetcher);
  const assets = selectAssets(release, names);
  await preserveAssets(repository, assets, names, bytes, token, fetcher);
  for (const [index, asset] of assets.entries()) {
    if (asset !== undefined) continue;
    const response = await fetcher(
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(names[index])}`,
      {
        method: "POST",
        headers: headers(token, "application/octet-stream"),
        body: bytes[index],
        signal: AbortSignal.timeout(30_000),
      },
    );
    cancelBody(response);
    assert.equal(
      response.status,
      201,
      `native release asset upload failed: ${names[index]}; existing assets preserved`,
    );
  }
  assert.ok(
    await nativeAssetsComplete(repository, version, token, fetcher),
    "native release asset pair is still incomplete",
  );
}

/** @param {string} repository @param {string} version @param {string} token @param {typeof fetch} fetcher @returns {Promise<object>} */
async function ensureRelease(repository, version, token, fetcher) {
  const release = await findRelease(repository, version, token, fetcher);
  if (release === undefined) {
    const response = await request(repository, "/releases", token, fetcher, {
      method: "POST",
      body: JSON.stringify({
        tag_name: `v${version}`,
        name: `v${version}`,
        draft: false,
        prerelease: false,
        make_latest: "false",
      }),
      headers: { "content-type": "application/json" },
    });
    if (response.status !== 201) cancelBody(response);
    assert.equal(
      response.status,
      201,
      "native release creation failed; no permission escalation or retry was attempted",
    );
    return validateRelease(await jsonBody(response), version);
  }
  return release;
}

/** @param {string} repository @param {(object|undefined)[]} assets @param {string[]} names @param {Buffer[]} bytes @param {string} token @param {typeof fetch} fetcher @returns {Promise<void>} */
async function preserveAssets(
  repository,
  assets,
  names,
  bytes,
  token,
  fetcher,
) {
  for (const [index, asset] of assets.entries()) {
    if (asset === undefined) continue;
    const existing = await download(
      repository,
      asset.id,
      token,
      fetcher,
      index === 0 ? LIMIT : 256,
    );
    assert.ok(
      existing.equals(bytes[index]),
      `native release asset conflict: ${names[index]}; existing bytes preserved`,
    );
  }
}

/**
 * The verify command reads this pair before a write credential exists; upload
 * rereads the same gated bytes. The exact sidecar binds archive filename and
 * content; arbitrary extra files are never sent.
 * @param {string} version Exact release.
 * @param {string} directory Artifact owner directory.
 * @returns {Promise<Buffer[]>} Archive then sidecar.
 */
async function localPair(version, directory) {
  const names = nativeAssetNames(version);
  const bytes = await Promise.all(
    names.map((name) => readFile(join(directory, name))),
  );
  verifyPair(names[0], bytes[0], bytes[1]);
  return bytes;
}

/** @param {string} name @param {Buffer} archive @param {Buffer} checksum */
function verifyPair(name, archive, checksum) {
  assert.ok(
    archive.length > 0 && archive.length <= LIMIT,
    "native archive exceeds the release byte budget",
  );
  const digest = createHash("sha256").update(archive).digest("hex");
  assert.equal(
    checksum.toString("utf8"),
    `${digest}  ${name}\n`,
    `native release checksum conflict: ${name}; existing bytes preserved`,
  );
}

/** @param {object} release @param {string[]} names @returns {(object|undefined)[]} */
function selectAssets(release, names) {
  return names.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    assert.ok(
      matches.length <= 1,
      `native release asset is duplicated: ${name}`,
    );
    const asset = matches[0];
    if (asset !== undefined) {
      assert.ok(
        Number.isSafeInteger(asset.id) &&
          asset.id > 0 &&
          asset.state === "uploaded",
        `native release asset is not uploaded: ${name}; existing asset preserved`,
      );
    }
    return asset;
  });
}

/** @param {string} repository @param {string} version @param {string|undefined} token @param {typeof fetch} fetcher */
async function findRelease(repository, version, token, fetcher) {
  nativeAssetNames(version);
  const response = await request(
    repository,
    `/releases/tags/v${version}`,
    token,
    fetcher,
  );
  if (response.status === 404) {
    cancelBody(response);
    return undefined;
  }
  if (response.status !== 200) cancelBody(response);
  assert.equal(
    response.status,
    200,
    "native release lookup failed; absence was not assumed",
  );
  return validateRelease(await jsonBody(response), version);
}

/** @param {object} release @param {string} version @returns {object} */
function validateRelease(release, version) {
  assert.ok(
    release !== null &&
      typeof release === "object" &&
      Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      release.tag_name === `v${version}` &&
      release.draft === false &&
      Array.isArray(release.assets),
    "native release metadata is invalid",
  );
  return release;
}

/** @param {string} repository @param {number} id @param {string|undefined} token @param {typeof fetch} fetcher @param {number} limit */
async function download(repository, id, token, fetcher, limit = LIMIT) {
  const response = await request(
    repository,
    `/releases/assets/${id}`,
    token,
    fetcher,
    { headers: { accept: "application/octet-stream" } },
  );
  if (response.status !== 200) cancelBody(response);
  assert.equal(response.status, 200, "native release asset download failed");
  return await boundedBody(response, limit);
}

/**
 * Stop before retaining an oversized body. Cancellation is initiated but never
 * awaited: an uncooperative producer cannot hold the release command open after
 * refusal. The reader lock is released synchronously on every path.
 * @param {Response} response GitHub HTTP response.
 * @param {number} limit Maximum retained bytes, independent of Content-Length.
 * @returns {Promise<Buffer>} Bounded actual body.
 */
async function boundedBody(response, limit = LIMIT) {
  assert.ok(response.body !== null, "native release response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      assert.ok(
        size <= limit,
        "native release response exceeds the byte budget",
      );
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** @param {Response} response @returns {Promise<object>} Bounded release metadata. */
async function jsonBody(response) {
  return JSON.parse(
    (await boundedBody(response, 1024 * 1024)).toString("utf8"),
  );
}

/** @param {Response} response Unconsumed missing-release body. */
function cancelBody(response) {
  void response.body?.cancel().catch(() => {});
}

/** @param {string} repository @param {string} path @param {string|undefined} token @param {typeof fetch} fetcher @param {RequestInit} options */
function request(repository, path, token, fetcher, options = {}) {
  assert.match(repository, REPOSITORY, "native release repository is invalid");
  return fetcher(`https://api.github.com/repos/${repository}${path}`, {
    ...options,
    headers: { ...headers(token), ...options.headers },
    signal: AbortSignal.timeout(30_000),
  });
}

/** @param {string|undefined} token @param {string|undefined} contentType @returns {Record<string,string>} */
function headers(token, contentType) {
  return {
    accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(contentType === undefined ? {} : { "content-type": contentType }),
  };
}

/** The only runtime boundary; diagnostics never echo response bodies or tokens. */
async function main() {
  const [command, version, directory] = process.argv.slice(2);
  try {
    if (command === "check" && directory === undefined) {
      process.exitCode = (await nativeAssetsComplete(
        process.env.GITHUB_REPOSITORY,
        version,
        process.env.GH_TOKEN,
      ))
        ? 0
        : 1;
    } else if (command === "verify" && directory !== undefined) {
      await localPair(version, directory);
    } else if (command === "upload" && directory !== undefined) {
      await uploadNativeAssets(
        process.env.GITHUB_REPOSITORY,
        version,
        directory,
        process.env.GH_TOKEN,
      );
    } else {
      process.stderr.write(
        "usage: native-assets.mjs check <version> | verify <version> <directory> | upload <version> <directory>\n",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof assert.AssertionError ? error.message : "native release request or artifact read failed"}\n`,
    );
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
