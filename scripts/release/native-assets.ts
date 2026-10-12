/** @file Publish the private native archive beside its exact Client release, without another npm product. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = /^\d{4}\.\d{3,4}\.\d+$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const LIMIT = 8 * 1024 * 1024;
/** Creating an asset-only release must not change GitHub's latest release. */
export const NATIVE_RELEASE_LATEST_SELECTION = "false";
// The dependency-free CLI snapshots its environment only at module startup.
// eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- Release-token CLI bootstrap must use only Node built-ins, not dependency execution.
const environment = process.env;

interface NativeAsset {
  readonly id: number;
  readonly name: string;
  readonly state: string;
}
interface NativeRelease {
  readonly id: number;
  readonly assets: readonly NativeAsset[];
}
interface ReleaseApi {
  readonly repository: string;
  readonly token: string;
  readonly fetcher: typeof fetch;
}
/** Upload accepts only the release workflow's existing late-minted authority. */
export interface NativeUploadOptions {
  readonly token: string;
  readonly fetcher?: typeof fetch;
}
type AssetNames = readonly [string, string];
type AssetBytes = readonly [Buffer, Buffer];
type SelectedAssets = readonly [
  NativeAsset | undefined,
  NativeAsset | undefined,
];

/**
 * Check every existing member before uploading a missing one. Retries never
 * delete, replace, or clobber a conflicting archive or checksum. The workflow
 * has already committed and pushed the tag before minting its App token.
 * @param repository Owner/repository.
 * @param version Exact Client release.
 * @param directory Gated artifact directory.
 * @param options Existing release authority and isolated HTTP seam.
 * @returns Both assets have exactly the gated bytes.
 */
export async function uploadNativeAssets(
  repository: string,
  version: string,
  directory: string,
  options: NativeUploadOptions,
) {
  assert.ok(
    options.token,
    "native release upload requires the existing release App token",
  );
  const api: ReleaseApi = {
    repository,
    token: options.token,
    fetcher: options.fetcher ?? fetch,
  };
  const names = nativeAssetNames(version);
  const bytes = await localPair(version, directory);
  const release = await ensureRelease(api, version);
  const assets = selectAssets(release, names);
  await preserveAssets(api, assets, names, bytes);
  for (const index of [0, 1] as const) {
    if (assets[index] === undefined) {
      await uploadAsset(api, release.id, names[index], bytes[index]);
    }
  }
  assert.ok(
    await nativeAssetsComplete(repository, version, options.token, api.fetcher),
    "native release asset pair is still incomplete",
  );
}

/**
 * Check actual downloaded bytes, not just asset names. Missing or partial pairs
 * return false; malformed or conflicting bytes fail. Only a 404 is absence.
 * Legacy npm-only tags are unaffected when this module is absent from the tag.
 * @param repository Owner/repository.
 * @param version Exact Client release.
 * @param token Optional read-only workflow token.
 * @param fetcher Hermetic HTTP seam; production uses the fixed GitHub API.
 * @returns Whether both uploaded assets are complete and consistent.
 */
export async function nativeAssetsComplete(
  repository: string,
  version: string,
  token = "",
  fetcher = fetch,
) {
  const api: ReleaseApi = { repository, token, fetcher };
  const names = nativeAssetNames(version);
  const release = await findRelease(api, version);
  if (release === undefined) {
    return false;
  }
  const [archiveAsset, checksumAsset] = selectAssets(release, names);
  if (archiveAsset === undefined || checksumAsset === undefined) {
    return false;
  }
  const archive = await download(api, archiveAsset.id);
  const checksum = await download(api, checksumAsset.id, 256);
  verifyPair(names[0], archive, checksum);
  return true;
}

/**
 * The obligatory pair is named from the exact Client calendar release.
 * @param version Exact Client release, never a range or alias.
 * @returns Archive then digest sidecar names.
 */
export function nativeAssetNames(version: string): AssetNames {
  assert.match(version, VERSION, "native assets require a calendar version");
  const archive = `moltzap-native-plugins-${version}.tgz`;
  return [archive, `${archive}.sha256`];
}

/** The CLI is the sole runtime boundary; diagnostics never echo bodies or credentials. */
async function main(): Promise<number> {
  const [command, version, directory] = process.argv.slice(2);
  try {
    assert.ok(version !== undefined, "native release version is missing");
    return await dispatch(command ?? "", version, directory);
  } catch (error) {
    process.stderr.write(
      `${error instanceof assert.AssertionError ? error.message : "native release request or artifact read failed"}\n`,
    );
    return 2;
  }
}

async function dispatch(
  command: string,
  version: string,
  directory?: string,
): Promise<number> {
  if (command === "check" && directory === undefined) {
    const repository = environment.GITHUB_REPOSITORY;
    assert.ok(repository !== undefined, "native release repository is missing");
    const complete = await nativeAssetsComplete(
      repository,
      version,
      environment.GH_TOKEN ?? "",
    );
    return complete ? 0 : 1;
  }
  if (command === "verify") {
    assert.ok(directory !== undefined, "native artifact directory is missing");
    await localPair(version, directory);
    return 0;
  }
  if (command === "upload") {
    assert.ok(directory !== undefined, "native artifact directory is missing");
    await uploadFromEnvironment(version, directory);
    return 0;
  }
  process.stderr.write(
    "usage: native-assets.ts check <version> | verify <version> <directory> | upload <version> <directory>\n",
  );
  return 2;
}

async function uploadFromEnvironment(version: string, directory: string) {
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GH_TOKEN;
  assert.ok(
    repository !== undefined && token !== undefined,
    "native release upload authority is missing",
  );
  await uploadNativeAssets(repository, version, directory, { token });
}

/** Upload sends only one filename-bound member after the whole existing pair was verified. */
async function uploadAsset(
  api: ReleaseApi,
  releaseId: number,
  name: string,
  bytes: Buffer,
) {
  const response = await api.fetcher(
    `https://uploads.github.com/repos/${api.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: headers(api.token, "application/octet-stream"),
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30_000),
    },
  );
  cancelBody(response);
  assert.equal(
    response.status,
    201,
    `native release asset upload failed: ${name}; existing assets preserved`,
  );
}

/** Creation leaves the pushed tag and the latest-release selection intact. */
async function ensureRelease(
  api: ReleaseApi,
  version: string,
): Promise<NativeRelease> {
  const release = await findRelease(api, version);
  if (release !== undefined) {
    return release;
  }
  const response = await request(api, "/releases", {
    method: "POST",
    body: JSON.stringify({
      tag_name: `v${version}`,
      name: `v${version}`,
      draft: false,
      prerelease: false,
      make_latest: NATIVE_RELEASE_LATEST_SELECTION,
    }),
    headers: { "content-type": "application/json" },
  });
  if (response.status !== 201) {
    cancelBody(response);
  }
  assert.equal(
    response.status,
    201,
    "native release creation failed; no permission escalation or retry was attempted",
  );
  return validateRelease(await jsonBody(response), version);
}

/** Validate the complete existing pair before uploading either missing member. */
async function preserveAssets(
  api: ReleaseApi,
  assets: SelectedAssets,
  names: AssetNames,
  bytes: AssetBytes,
) {
  for (const index of [0, 1] as const) {
    const asset = assets[index];
    if (asset !== undefined) {
      const existing = await download(api, asset.id, index === 0 ? LIMIT : 256);
      assert.ok(
        existing.equals(bytes[index]),
        `native release asset conflict: ${names[index]}; existing bytes preserved`,
      );
    }
  }
}

/** Verify reads this exact pair before a write credential exists; upload rereads the gated bytes. */
async function localPair(
  version: string,
  directory: string,
): Promise<AssetBytes> {
  const names = nativeAssetNames(version);
  const bytes = await Promise.all([
    readFile(join(directory, names[0])),
    readFile(join(directory, names[1])),
  ]);
  verifyPair(names[0], bytes[0], bytes[1]);
  return bytes;
}

/** The sidecar binds the archive's content, exact name, and byte budget. */
function verifyPair(name: string, archive: Buffer, checksum: Buffer): void {
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

/** Duplicate and incomplete records cannot authorize preservation or upload. */
function selectAssets(
  release: NativeRelease,
  names: AssetNames,
): SelectedAssets {
  return [selectAsset(release, names[0]), selectAsset(release, names[1])];
}

function selectAsset(
  release: NativeRelease,
  name: string,
): NativeAsset | undefined {
  const matches = release.assets.filter((asset) => asset.name === name);
  assert.ok(matches.length <= 1, `native release asset is duplicated: ${name}`);
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
}

/** Only a 404 means absence; authentication and service failures remain errors. */
async function findRelease(
  api: ReleaseApi,
  version: string,
): Promise<NativeRelease | undefined> {
  nativeAssetNames(version);
  const response = await request(api, `/releases/tags/v${version}`);
  if (response.status === 404) {
    cancelBody(response);
    return undefined;
  }
  if (response.status !== 200) {
    cancelBody(response);
  }
  assert.equal(
    response.status,
    200,
    "native release lookup failed; absence was not assumed",
  );
  return validateRelease(await jsonBody(response), version);
}

/** GitHub metadata stays unknown until identity and consumed fields are checked. */
function validateRelease(release: unknown, version: string): NativeRelease {
  assert.ok(isObject(release), "native release metadata is invalid");
  assert.ok(
    typeof release.id === "number" &&
      Number.isSafeInteger(release.id) &&
      release.id > 0,
    "native release metadata is invalid",
  );
  assert.ok(
    release.tag_name === `v${version}` &&
      release.draft === false &&
      Array.isArray(release.assets),
    "native release metadata is invalid",
  );
  return { id: release.id, assets: release.assets.map(validateAsset) };
}

function validateAsset(value: unknown): NativeAsset {
  assert.ok(isObject(value), "native release metadata is invalid");
  assert.ok(
    typeof value.id === "number" &&
      typeof value.name === "string" &&
      typeof value.state === "string",
    "native release metadata is invalid",
  );
  return { id: value.id, name: value.name, state: value.state };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Actual downloaded bytes are bounded even when Content-Length lies. */
async function download(api: ReleaseApi, id: number, limit = LIMIT) {
  const response = await request(api, `/releases/assets/${id}`, {
    headers: { accept: "application/octet-stream" },
  });
  if (response.status !== 200) {
    cancelBody(response);
  }
  assert.equal(response.status, 200, "native release asset download failed");
  return await boundedBody(response, limit);
}

/** Bounded metadata is decoded only after its byte budget is satisfied. */
async function jsonBody(response: Response): Promise<unknown> {
  const value: unknown = JSON.parse(
    (await boundedBody(response, 1024 * 1024)).toString("utf8"),
  );
  return value;
}

/**
 * Refuse oversized actual chunks before retaining them. Cancellation is
 * initiated but never awaited: an uncooperative producer cannot hold refusal
 * open. The reader lock is released synchronously on every path.
 */
async function boundedBody(response: Response, limit = LIMIT) {
  assert.ok(response.body !== null, "native release response body is missing");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, size);
      }
      const chunk: unknown = result.value;
      assert.ok(
        chunk instanceof Uint8Array,
        "native release response chunk is invalid",
      );
      size += chunk.byteLength;
      assert.ok(
        size <= limit,
        "native release response exceeds the byte budget",
      );
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Cancellation never waits for an untrusted body's cooperation. */
function cancelBody(response: Response): void {
  if (response.body !== null) {
    void response.body.cancel().catch(() => undefined);
  }
}

/** Requests stay within the fixed API origin and a bounded lifetime. */
function request(api: ReleaseApi, path: string, options: RequestInit = {}) {
  assert.match(
    api.repository,
    REPOSITORY,
    "native release repository is invalid",
  );
  const requestHeaders = new Headers(headers(api.token));
  new Headers(options.headers).forEach((value, key) => {
    requestHeaders.set(key, value);
  });
  return api.fetcher(`https://api.github.com/repos/${api.repository}${path}`, {
    ...options,
    headers: requestHeaders,
    signal: AbortSignal.timeout(30_000),
  });
}

function headers(token: string, contentType = ""): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    ...(contentType === "" ? {} : { "content-type": contentType }),
  };
}

if (import.meta.main) {
  const status = await main();
  process.exitCode = status;
}
