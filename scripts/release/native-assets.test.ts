/** @file Release retries preserve uploaded bytes and reject partial or conflicting pairs. */
import { FastCheck as fc } from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  NATIVE_RELEASE_LATEST_SELECTION,
  nativeAssetNames,
  nativeAssetsComplete,
  uploadNativeAssets,
} from "./native-assets.ts";

const VERSION = "2026.1010.1";
const NAMES = nativeAssetNames(VERSION);
const ARCHIVE = Buffer.from("hermetic release-byte fixture");
const CHECKSUM = Buffer.from(
  `${createHash("sha256").update(ARCHIVE).digest("hex")}  ${NAMES[0]}\n`,
);
const PAIR = [ARCHIVE, CHECKSUM] as const;
interface Asset {
  readonly name: string;
  bytes: Buffer;
}
interface Creation {
  readonly tagName?: unknown;
  readonly makeLatest?: unknown;
}

await test("asset names bind every generated calendar version without normalization", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1000, max: 9999 }),
      fc.integer({ min: 100, max: 1231 }),
      fc.nat(),
      (year, date, patch) => {
        const version = `${year}.${date}.${patch}`;
        const [archive, checksum] = nativeAssetNames(version);
        assert.equal(archive, `moltzap-native-plugins-${version}.tgz`);
        assert.equal(checksum, `${archive}.sha256`);
      },
    ),
  );
});

await test("asset names retain the exact Client release", () => {
  assert.deepEqual(NAMES, [
    `moltzap-native-plugins-${VERSION}.tgz`,
    `moltzap-native-plugins-${VERSION}.tgz.sha256`,
  ]);
});

for (const version of [
  "latest",
  "^2026.1010.1",
  "2026.1010.1/secret",
  "1.0.0",
]) {
  await test(`native asset names reject ${version}`, () => {
    assert.throws(() => nativeAssetNames(version));
  });
}

for (const installed of [[], [0], [1]]) {
  await test(`partial pair ${installed.join(",")} stays incomplete`, async () => {
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
  });
}

await test("an absent release stays incomplete", async () => {
  const peer = github([0, 1]);
  peer.missing();
  assert.equal(
    await nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    false,
  );
});

await test("completion checks downloaded content, including an existing archive's corruption", async () => {
  const peer = github([0, 1]);
  assert.equal(
    await nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    true,
  );
  peer.asset(1).bytes = Buffer.from("different bytes");
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, peer.fetcher),
    /checksum conflict/u,
  );
});

for (const status of [401, 403, 429, 503]) {
  await test(`lookup status ${status} does not become absence`, async () => {
    await assert.rejects(
      nativeAssetsComplete("owner/repo", VERSION, undefined, () =>
        Promise.resolve(new Response(null, { status })),
      ),
      /lookup failed/u,
    );
  });
}

await test("wrong release identity is refused", async () => {
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, () =>
      Promise.resolve(
        Response.json({ id: 42, tag_name: "wrong", draft: false, assets: [] }),
      ),
    ),
    /metadata is invalid/u,
  );
});

await test("oversized actual chunks fail without awaiting hostile cancellation", async () => {
  const peer = github([0, 1]);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
      // Deliberately uncooperative producer: refusing the body must not await cancellation.
      return new Promise<never>(() => {});
    },
  });
  const fetcher: typeof fetch = (input, options) =>
    requestUrl(input).pathname.endsWith("/releases/assets/1")
      ? Promise.resolve(
          new Response(body, { headers: { "content-length": "1" } }),
        )
      : peer.fetcher(input, options);
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, fetcher),
    /byte budget/u,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

await test("release metadata is bounded before JSON decoding", async () => {
  await assert.rejects(
    nativeAssetsComplete("owner/repo", VERSION, undefined, () =>
      Promise.resolve(new Response(" ".repeat(1024 * 1024 + 1))),
    ),
    /byte budget/u,
  );
});

for (const installed of [[], [0], [1], [0, 1]]) {
  await test(`retry fills pair ${installed.join(",")} while preserving its existing members`, async () => {
    await withPair(async (directory) => {
      const peer = github(installed);
      await uploadNativeAssets("owner/repo", VERSION, directory, {
        token: "fixture-token",
        fetcher: peer.fetcher,
      });
      assert.deepEqual([peer.asset(1).bytes, peer.asset(2).bytes], PAIR);
    });
  });
}

for (const index of [0, 1] as const) {
  await test(`conflicting member ${index} blocks upload of its missing mate`, async () => {
    await withPair(async (directory) => {
      const peer = github([index]);
      const conflict = Buffer.from("preserve this conflicting existing asset");
      peer.asset(index + 1).bytes = conflict;
      await assert.rejects(
        uploadNativeAssets("owner/repo", VERSION, directory, {
          token: "fixture-token",
          fetcher: peer.fetcher,
        }),
        /asset conflict:.*existing bytes preserved/u,
      );
      assert.equal(peer.assets.size, 1);
      assert.deepEqual(peer.asset(index + 1).bytes, conflict);
    });
  });
}

await test("creating the missing release preserves its tag and latest selection", async () => {
  await withPair(async (directory) => {
    const peer = github();
    peer.missing();
    await uploadNativeAssets("owner/repo", VERSION, directory, {
      token: "fixture-token",
      fetcher: peer.fetcher,
    });
    assert.equal(peer.creation()?.tagName, `v${VERSION}`);
    assert.equal(peer.creation()?.makeLatest, NATIVE_RELEASE_LATEST_SELECTION);
    assert.deepEqual([peer.asset(1).bytes, peer.asset(2).bytes], PAIR);
  });
});

await test("invalid local checksum fails before any remote mutation", async () => {
  await withPair(async (directory) => {
    await writeFile(join(directory, NAMES[1]), "wrong checksum\n");
    const peer = github();
    await assert.rejects(
      uploadNativeAssets("owner/repo", VERSION, directory, {
        token: "fixture-token",
        fetcher: peer.fetcher,
      }),
      /checksum conflict/u,
    );
    assert.equal(peer.assets.size, 0);
    assert.equal(peer.creation(), undefined);
  });
});

/** The in-memory HTTP peer rejects overwrite and exposes only resulting release state. */
function github(installed: readonly number[] = []) {
  const assets = new Map<number, Asset>();
  for (const index of installed) {
    const name = NAMES[index];
    const bytes = PAIR[index];
    assert.ok(name !== undefined && bytes !== undefined);
    assets.set(index + 1, { name, bytes });
  }
  const state: { exists: boolean; creation?: Creation } = { exists: true };
  const release = () => releaseState(assets);
  const fetcher: typeof fetch = (input, options = {}) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith(`/releases/tags/v${VERSION}`)) {
      return Promise.resolve(
        Response.json(release(), { status: state.exists ? 200 : 404 }),
      );
    }
    if (url.pathname.endsWith("/releases") && options.method === "POST") {
      state.creation = decodeCreation(options.body);
      state.exists = true;
      return Promise.resolve(Response.json(release(), { status: 201 }));
    }
    if (url.hostname === "uploads.github.com") {
      return Promise.resolve(acceptUpload(assets, url, options.body));
    }
    const asset = assets.get(Number(url.pathname.split("/").at(-1)));
    assert.ok(asset, "unexpected fixture request");
    return Promise.resolve(new Response(new Uint8Array(asset.bytes)));
  };
  return {
    assets,
    fetcher,
    asset(id: number) {
      const asset = assets.get(id);
      assert.ok(asset);
      return asset;
    },
    creation() {
      return state.creation;
    },
    missing() {
      state.exists = false;
    },
  };
}

function releaseState(assets: ReadonlyMap<number, Asset>) {
  return {
    id: 42,
    tag_name: `v${VERSION}`,
    draft: false,
    assets: [...assets].map(([id, value]) => ({
      id,
      name: value.name,
      state: "uploaded",
    })),
  };
}

function decodeCreation(body: RequestInit["body"]): Creation {
  assert.ok(typeof body === "string");
  const value: unknown = JSON.parse(body);
  assert.ok(isObject(value));
  return { tagName: value.tag_name, makeLatest: value.make_latest };
}

function acceptUpload(
  assets: Map<number, Asset>,
  url: URL,
  body: RequestInit["body"],
): Response {
  const name = url.searchParams.get("name");
  assert.ok(
    name !== null && ![...assets.values()].some((asset) => asset.name === name),
    "fixture refuses overwrite",
  );
  assert.ok(body instanceof Uint8Array, "fixture accepts byte uploads only");
  const id = NAMES.indexOf(name) + 1;
  assert.ok(id > 0, "fixture refuses an undeclared asset");
  assets.set(id, { name, bytes: Buffer.from(body) });
  return Response.json({}, { status: 201 });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Each retry test owns a private artifact directory and removes it on every exit. */
async function withPair(
  operation: (directory: string) => Promise<unknown>,
): Promise<undefined> {
  const directory = await mkdtemp(join(tmpdir(), "native-release-test-"));
  try {
    await writeFile(join(directory, NAMES[0]), ARCHIVE);
    await writeFile(join(directory, NAMES[1]), CHECKSUM);
    await operation(directory);
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
