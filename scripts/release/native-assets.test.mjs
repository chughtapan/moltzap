/** @file Native release retries preserve matching bytes and reject incomplete or conflicting artifacts. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  nativeAssetNames,
  nativeAssetsComplete,
  uploadNativeAssets,
} from "./native-assets.mjs";

const VERSION = "2026.1010.1";
const NAMES = nativeAssetNames(VERSION);
const ARCHIVE = Buffer.from("hermetic release-byte fixture");
const CHECKSUM = Buffer.from(
  `${createHash("sha256").update(ARCHIVE).digest("hex")}  ${NAMES[0]}\n`,
);

/**
 * The only HTTP peer is an in-memory GitHub API fixture. Requests never escape
 * to a provider, and writes model preservation rather than overwriting assets.
 * @param {number[]} installed Indices of the existing byte pair.
 * @returns {object} Mutable API fixture and exact request trace.
 */
function github(installed = []) {
  const assets = new Map(
    installed.map((index) => [
      index + 1,
      { name: NAMES[index], bytes: [ARCHIVE, CHECKSUM][index] },
    ]),
  );
  const requests = [];
  let exists = true;
  const release = () => ({
    id: 42,
    tag_name: `v${VERSION}`,
    draft: false,
    assets: [...assets].map(([id, value]) => ({
      id,
      name: value.name,
      state: "uploaded",
    })),
  });
  const fetcher = async (input, options = {}) => {
    const url = new URL(input);
    requests.push([options.method ?? "GET", url.pathname, options]);
    if (url.pathname.endsWith(`/releases/tags/v${VERSION}`))
      return Response.json(release(), { status: exists ? 200 : 404 });
    if (url.pathname.endsWith("/releases") && options.method === "POST") {
      exists = true;
      return Response.json(release(), { status: 201 });
    }
    if (url.hostname === "uploads.github.com") {
      const name = url.searchParams.get("name");
      assert.ok(
        ![...assets.values()].some((asset) => asset.name === name),
        "fixture refuses an overwrite",
      );
      const id = NAMES.indexOf(name) + 1;
      assets.set(id, { name, bytes: Buffer.from(options.body) });
      return Response.json({}, { status: 201 });
    }
    const asset = assets.get(Number(url.pathname.split("/").at(-1)));
    assert.ok(asset, "unexpected GitHub fixture request");
    return new Response(asset.bytes);
  };
  return {
    assets,
    requests,
    fetcher,
    missing: () => {
      exists = false;
    },
  };
}

/** @param {Function} operation @returns {Promise<void>} */
async function withPair(operation) {
  const directory = await mkdtemp(join(tmpdir(), "native-release-test-"));
  try {
    for (const [index, name] of NAMES.entries())
      await writeFile(join(directory, name), [ARCHIVE, CHECKSUM][index]);
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("asset names retain exact Client release and reject ranges", () => {
  assert.deepEqual(NAMES, [
    `moltzap-native-plugins-${VERSION}.tgz`,
    `moltzap-native-plugins-${VERSION}.tgz.sha256`,
  ]);
  for (const invalid of [
    "latest",
    "^2026.1010.1",
    "2026.1010.1/secret",
    "1.0.0",
  ])
    assert.throws(() => nativeAssetNames(invalid));
});

test("absent release and either partial pair are incomplete, never a completed release", async () => {
  for (const installed of [[], [0], [1]]) {
    const peer = github(installed);
    assert.equal(
      await nativeAssetsComplete(
        "owner/repo",
        VERSION,
        undefined,
        peer.fetcher,
      ),
      false,
    );
  }
  const peer = github([0, 1]);
  peer.missing();
  assert.equal(
    await nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    false,
  );
});

test("complete pair checks downloaded content and not only asset metadata", async () => {
  const peer = github([0, 1]);
  assert.equal(
    await nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    true,
  );
  peer.assets.get(1).bytes = Buffer.from("different bytes");
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    /checksum conflict/u,
  );
});

test("API failures and ambiguous metadata never become absence", async () => {
  for (const status of [401, 403, 429, 503])
    await assert.rejects(
      nativeAssetsComplete(
        "owner/repo",
        VERSION,
        undefined,
        async () => new Response(null, { status }),
      ),
      /lookup failed/u,
    );
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, async () =>
      Response.json({ id: 42, tag_name: "wrong", draft: false, assets: [] }),
    ),
    /metadata is invalid/u,
  );
});

test("oversized asset is refused from actual chunks without awaiting hostile cancellation", async () => {
  const peer = github([0, 1]);
  let cancelled = false;
  let body;
  const fetcher = async (input, options) => {
    if (!String(input).endsWith("/releases/assets/1"))
      return await peer.fetcher(input, options);
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    return new Response(body, { headers: { "content-length": "1" } });
  };
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, fetcher),
    /byte budget/u,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("oversized release metadata is bounded before JSON decoding", async () => {
  const fetcher = async () => new Response(" ".repeat(1024 * 1024 + 1));
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, fetcher),
    /byte budget/u,
  );
});

test("retry uploads only missing assets and preserves a matching pair", async () => {
  await withPair(async (directory) => {
    for (const installed of [[], [0], [1], [0, 1]]) {
      const peer = github(installed);
      await uploadNativeAssets(
        "owner/repo",
        VERSION,
        directory,
        "fixture-token",
        peer.fetcher,
      );
      assert.equal(
        peer.requests.filter(([method]) => method === "POST").length,
        2 - installed.length,
      );
      assert.deepEqual(
        [...peer.assets.values()]
          .map(({ bytes }) => bytes)
          .sort(Buffer.compare),
        [ARCHIVE, CHECKSUM].sort(Buffer.compare),
      );
    }
  });
});

test("conflicting archive or checksum prevents every upload, including the missing mate", async () => {
  await withPair(async (directory) => {
    for (const index of [0, 1]) {
      const peer = github([index]);
      peer.assets.get(index + 1).bytes = Buffer.from(
        "preserve this conflicting existing asset",
      );
      await assert.rejects(
        uploadNativeAssets(
          "owner/repo",
          VERSION,
          directory,
          "fixture-token",
          peer.fetcher,
        ),
        new RegExp(
          `asset conflict: ${NAMES[index].replaceAll(".", "\\.")}; existing bytes preserved`,
          "u",
        ),
      );
      assert.equal(
        peer.requests.filter(([method]) => method === "POST").length,
        0,
      );
    }
  });
});

test("a missing release is created without new permissions or implicit latest selection", async () => {
  await withPair(async (directory) => {
    const peer = github();
    peer.missing();
    await uploadNativeAssets(
      "owner/repo",
      VERSION,
      directory,
      "fixture-token",
      peer.fetcher,
    );
    const request = peer.requests.find(
      ([method, path]) => method === "POST" && path.endsWith("/releases"),
    );
    assert.deepEqual(JSON.parse(request[2].body), {
      tag_name: `v${VERSION}`,
      name: `v${VERSION}`,
      draft: false,
      prerelease: false,
      make_latest: "false",
    });
  });
});

test("invalid local pair fails before any GitHub request", async () => {
  await withPair(async (directory) => {
    await writeFile(join(directory, NAMES[1]), "wrong checksum\n");
    const peer = github();
    await assert.rejects(
      uploadNativeAssets(
        "owner/repo",
        VERSION,
        directory,
        "fixture-token",
        peer.fetcher,
      ),
      /checksum conflict/u,
    );
    assert.equal(peer.requests.length, 0);
  });
});

test("workflow gates packaging before the App token and keeps legacy releases npm-only", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /RELEASE_PACKAGES: identity router client openclaw-channel/u,
  );
  assert.match(
    workflow,
    /git cat-file -e "\$RELEASE_COMMIT:scripts\/release\/native-assets\.mjs"/u,
  );
  assert.match(workflow, /NATIVE_CONTRACT=false/u);
  assert.ok(
    workflow.indexOf("@moltzap/native-plugins:package") <
      workflow.indexOf("actions/create-github-app-token"),
  );
  assert.ok(
    workflow.indexOf("pnpm docs:generate") <
      workflow.indexOf("actions/create-github-app-token"),
  );
  const credentialScopes = workflow
    .split(/\n      - /u)
    .filter((step) =>
      /(?:RELEASE_TOKEN|GH_TOKEN): \$\{\{ steps\.app-token/u.test(step),
    );
  assert.equal(credentialScopes.length, 2);
  for (const step of credentialScopes)
    assert.doesNotMatch(step, /\b(?:pnpm|npm|npx|corepack)\s/u);
  assert.match(workflow, /native-assets\.mjs verify "\$VERSION"/u);
  assert.match(workflow, /native-assets\.mjs upload "\$VERSION"/u);
  assert.doesNotMatch(workflow, /permission-(?:workflows|packages):/u);
});
