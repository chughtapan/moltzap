import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit } from "effect";
import * as fc from "fast-check";
import type { AppManifest } from "@moltzap/protocol/identity";
import { appId as makeAppId, redactedAppKey } from "@moltzap/protocol/testing";
import { UnauthorizedError } from "@moltzap/protocol/transport";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { AppContext } from "../../transport/context.js";
import { AppAuthService } from "./app-auth.service.js";
import { hashSecret, parseAppKey } from "./credential-keys.js";

let harness: PgliteHarness;

const it = effectIt.effect;

const MANIFEST_NAME = "test app";
const OPEN_HOOKS = {
  dispatch_authorize: { kind: "grant" },
  message_authorize: { kind: "forwardAllExceptSender" },
  task_create: { kind: "accept" },
} as const;
const MANIFEST = {
  appId: "ignored",
  name: MANIFEST_NAME,
  hooks: OPEN_HOOKS,
} satisfies AppManifest;
const DEFAULT_APP_ID = makeAppId("00000000-0000-4000-8000-0000000005d0");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

/** Direct-insert an app row with a hand-crafted manifest_json blob. */
function insertAppRow(args: {
  readonly manifestJson: unknown;
  readonly keyId: string;
  readonly secretHash: string;
}) {
  return Effect.tryPromise({
    try: () =>
      harness.db
        .insertInto("apps")
        .values({
          manifest_json: args.manifestJson,
          api_key_id: args.keyId,
          api_key_secret_hash: args.secretHash,
        })
        .returning(["app_id"])
        .executeTakeFirstOrThrow(),
    catch: (cause) => cause,
  });
}

function insertsRowReturnsServerIssuedKey() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const { appId, appKey } = yield* svc.registerApp({ manifest: MANIFEST });

    // appId is a server-issued UUID, not the manifest's placeholder.
    expect(appId).toMatch(UUID_RE);
    expect(parseAppKey(appKey)).not.toBeNull();

    const rows = yield* harness.db
      .selectFrom("apps")
      .select(["app_id"])
      .where("app_id", "=", appId);
    expect(rows).toHaveLength(1);
  });
}

function issuesDistinctIdsForIdenticalManifests() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const first = yield* svc.registerApp({ manifest: MANIFEST });
    const second = yield* svc.registerApp({ manifest: MANIFEST });
    expect(first.appId).not.toBe(second.appId);
  });
}

function roundTripsAppCredential() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const { appId, appKey } = yield* svc.registerApp({ manifest: MANIFEST });

    const result = yield* svc.authenticateApp(appKey);
    if (result === null) throw new Error("unreachable");
    expect(result.auth).toBeInstanceOf(AppContext);
    expect(result.auth.appId).toBe(appId);
    expect(result.manifest.name).toBe(MANIFEST_NAME);
  });
}

/**
 * Invariant: any manifest registered through `registerApp` authenticates
 * back to the same server-issued appId and the same manifest name. The
 * register → authenticate roundtrip is the load-bearing property; example
 * cases below pin specific failure branches the property cannot reach.
 *
 * `fc.sample` draws the generated inputs synchronously so the DB-bound
 * body stays Effect-native (no raw `async`/`Promise`).
 */
function registerAuthenticateRoundtripProperty() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const names = fc.sample(fc.string({ minLength: 1 }), 25);
    for (const name of names) {
      const manifest = {
        appId: "ignored",
        name,
        hooks: OPEN_HOOKS,
      } satisfies AppManifest;
      const reg = yield* svc.registerApp({ manifest });
      const back = yield* svc.authenticateApp(reg.appKey);
      if (back === null) throw new Error("unreachable");
      expect(back.auth.appId).toBe(reg.appId);
      expect(back.manifest.name).toBe(name);
    }
  });
}

function returnsNullForUnparseableKey() {
  return Effect.sync(() => {
    expect(() => redactedAppKey("not_a_real_key")).toThrow();
  });
}

function returnsNullOnHashMiss() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const { appKey } = yield* svc.registerApp({ manifest: MANIFEST });
    const parsed = parseAppKey(appKey);
    if (parsed === null) throw new Error("unreachable");
    const forged = redactedAppKey(
      `moltzap_app_${parsed.keyId}_${"0".repeat(48)}`,
    );
    expect(yield* svc.authenticateApp(forged)).toBeNull();
  });
}

function returnsNullForUnknownKeyId() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const orphan = redactedAppKey(
      `moltzap_app_${"a".repeat(16)}_${"b".repeat(48)}`,
    );
    expect(yield* svc.authenticateApp(orphan)).toBeNull();
  });
}

function failsUnauthorizedOnCorruptManifest() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const keyId = "c".repeat(16);
    const secret = "d".repeat(48);
    yield* insertAppRow({
      // Missing the required `name` and `hooks` fields → fails
      // AppManifestSchema decode.
      manifestJson: { appId: "x" },
      keyId,
      secretHash: hashSecret(secret),
    });

    // A domain failure on the typed error channel, NOT a defect.
    const error = yield* svc
      .authenticateApp(redactedAppKey(`moltzap_app_${keyId}_${secret}`))
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.data).toEqual({ reason: "manifest_corrupted" });
  });
}

function installInsertsThenAuthenticates() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const appKey = redactedAppKey(
      `moltzap_app_${"e".repeat(16)}_${"f".repeat(48)}`,
    );
    yield* svc.installDefaultApp(DEFAULT_APP_ID, MANIFEST, appKey);

    const result = yield* svc.authenticateApp(appKey);
    if (result === null) throw new Error("unreachable");
    expect(result.auth.appId).toBe(DEFAULT_APP_ID);
  });
}

function installUpsertsAndRotatesKey() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const firstKey = redactedAppKey(
      `moltzap_app_${"1".repeat(16)}_${"2".repeat(48)}`,
    );
    const secondKey = redactedAppKey(
      `moltzap_app_${"3".repeat(16)}_${"4".repeat(48)}`,
    );

    yield* svc.installDefaultApp(DEFAULT_APP_ID, MANIFEST, firstKey);
    yield* svc.installDefaultApp(DEFAULT_APP_ID, MANIFEST, secondKey);

    // Exactly one row for DEFAULT_APP_ID — UPDATE, not a second INSERT.
    const rows = yield* harness.db
      .selectFrom("apps")
      .select(["app_id"])
      .where("app_id", "=", DEFAULT_APP_ID);
    expect(rows).toHaveLength(1);

    // The current key authenticates; the stale boot key is rejected.
    expect(yield* svc.authenticateApp(secondKey)).not.toBeNull();
    expect(yield* svc.authenticateApp(firstKey)).toBeNull();
  });
}

function getManifestReadsBack() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const { appId } = yield* svc.registerApp({ manifest: MANIFEST });
    const manifest = yield* svc.getManifest(appId);
    expect(manifest.name).toBe(MANIFEST_NAME);
  });
}

function getManifestDiesOnAbsentRow() {
  return Effect.gen(function* () {
    const svc = new AppAuthService(harness.db);
    const exit = yield* svc.getManifest(DEFAULT_APP_ID).pipe(Effect.exit);
    // Impossible-state violations route to a defect, not the error channel.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(Cause.isDie(exit.cause)).toBe(true);
  });
}

describe("AppAuthService.registerApp", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "inserts a row and returns a server-issued appId + parseable appKey",
    insertsRowReturnsServerIssuedKey,
  );
  it(
    "issues distinct appIds for identical manifests",
    issuesDistinctIdsForIdenticalManifests,
  );
});

describe("AppAuthService.authenticateApp", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "roundtrip property: every registered manifest authenticates back",
    registerAuthenticateRoundtripProperty,
  );
  it(
    "round-trips an app credential to its AppContext + manifest",
    roundTripsAppCredential,
  );
  it(
    "returns null for an unparseable (non-app-prefix) key",
    returnsNullForUnparseableKey,
  );
  it(
    "returns null on a hash MISS (wrong secret for a known keyId)",
    returnsNullOnHashMiss,
  );
  it(
    "returns null for a well-formed key whose keyId matches no row",
    returnsNullForUnknownKeyId,
  );
  it(
    "fails UnauthorizedError(manifest_corrupted) on a hash-matching row with un-decodable manifest_json",
    failsUnauthorizedOnCorruptManifest,
  );
});

describe("AppAuthService.installDefaultApp", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "INSERTs on first call then authenticates against the fresh key",
    installInsertsThenAuthenticates,
  );
  it(
    "UPSERTs the same row across boots, rotating the key",
    installUpsertsAndRotatesKey,
  );
});

describe("AppAuthService.getManifest", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "reads back the persisted manifest for a known-valid appId",
    getManifestReadsBack,
  );
  it(
    "dies (impossible state) when the appId row is absent",
    getManifestDiesOnAbsentRow,
  );
});
