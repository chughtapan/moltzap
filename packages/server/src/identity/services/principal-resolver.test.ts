import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import type { AppManifest } from "@moltzap/protocol/app";
import { UnauthorizedError } from "@moltzap/protocol";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { AgentContext, AppContext } from "../../transport/context.js";
import { AuthService } from "./auth.service.js";
import { AppAuthService } from "./app-auth.service.js";
import { PrincipalResolver } from "./principal-resolver.js";
import { hashSecret } from "./agent-auth.js";

let harness: PgliteHarness;

const it = effectIt.effect;

const MANIFEST_NAME = "test app";
const MANIFEST = {
  appId: "ignored",
  name: MANIFEST_NAME,
} satisfies AppManifest;
const ACTIVE_STATUS = "active";

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

function makeResolver() {
  return new PrincipalResolver(
    new AuthService(harness.db),
    new AppAuthService(harness.db),
  );
}

function dispatchesAgentKeyToAgentArm() {
  return Effect.gen(function* () {
    const reg = yield* new AuthService(harness.db).registerAgent({
      name: "alice",
    });
    const result = yield* makeResolver().resolve(reg.apiKey);
    if (result === null || result._tag !== "Agent") {
      throw new Error("expected Agent principal");
    }
    expect(result.auth).toBeInstanceOf(AgentContext);
    expect(result.auth.agentId).toBe(reg.agentId);
    // status narrowed from the DB-widened string to the closed union.
    expect(result.auth.agentStatus).toBe(ACTIVE_STATUS);
  });
}

function dispatchesAppKeyToAppArm() {
  return Effect.gen(function* () {
    const { appId, appKey } = yield* new AppAuthService(harness.db).registerApp(
      { manifest: MANIFEST },
    );
    const result = yield* makeResolver().resolve(appKey);
    if (result === null || result._tag !== "App") {
      throw new Error("expected App principal");
    }
    expect(result.auth).toBeInstanceOf(AppContext);
    expect(result.auth.appId).toBe(appId);
    expect(result.manifest.name).toBe(MANIFEST_NAME);
  });
}

/**
 * Invariant: dispatch follows the key prefix. An agent key always lands
 * on an `AgentContext`, an app key on an `AppContext`; the resolver never
 * crosses the arms. The example cases below pin the null/error branches
 * the property does not reach.
 *
 * `fc.sample` draws the generated arm-choices + agent-name suffixes
 * synchronously so the DB-bound body stays Effect-native.
 */
function prefixDispatchProperty() {
  return Effect.gen(function* () {
    const auth = new AuthService(harness.db);
    const appAuth = new AppAuthService(harness.db);
    const resolver = makeResolver();
    const armChoices = fc.sample(fc.boolean(), 20);
    for (const [index, isApp] of armChoices.entries()) {
      if (isApp) {
        const { appKey } = yield* appAuth.registerApp({ manifest: MANIFEST });
        const r = yield* resolver.resolve(appKey);
        expect(r?.auth).toBeInstanceOf(AppContext);
      } else {
        // `agents.name` is UNIQUE — the index keeps generated names distinct.
        const reg = yield* auth.registerAgent({ name: `prop-${index}` });
        const r = yield* resolver.resolve(reg.apiKey);
        expect(r?.auth).toBeInstanceOf(AgentContext);
      }
    }
  });
}

function returnsNullForUnknownPrefix() {
  return Effect.gen(function* () {
    const result = yield* makeResolver().resolve("bearer_some_session_token");
    expect(result).toBeNull();
  });
}

function returnsNullOnAgentHashMiss() {
  return Effect.gen(function* () {
    const orphan = `moltzap_agent_${"a".repeat(16)}_${"b".repeat(48)}`;
    expect(yield* makeResolver().resolve(orphan)).toBeNull();
  });
}

function propagatesCorruptManifestError() {
  return Effect.gen(function* () {
    const keyId = "c".repeat(16);
    const secret = "d".repeat(48);
    yield* Effect.tryPromise({
      try: () =>
        harness.db
          .insertInto("apps")
          .values({
            manifest_json: { appId: "x" },
            api_key_id: keyId,
            api_key_secret_hash: hashSecret(secret),
          })
          .returning(["app_id"])
          .executeTakeFirstOrThrow(),
      catch: (cause) => cause,
    });

    const error = yield* makeResolver()
      .resolve(`moltzap_app_${keyId}_${secret}`)
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.data).toEqual({ reason: "manifest_corrupted" });
  });
}

describe("PrincipalResolver.resolve", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "prefix-dispatch property: agent key → AgentContext, app key → AppContext",
    prefixDispatchProperty,
  );
  it(
    "dispatches a moltzap_agent_ key to the Agent arm",
    dispatchesAgentKeyToAgentArm,
  );
  it(
    "dispatches a moltzap_app_ key to the App arm with a manifest",
    dispatchesAppKeyToAppArm,
  );
  it(
    "returns null for a credential matching neither prefix",
    returnsNullForUnknownPrefix,
  );
  it(
    "returns null on an agent hash MISS (right prefix, no matching row)",
    returnsNullOnAgentHashMiss,
  );
  it(
    "propagates UnauthorizedError(manifest_corrupted) from the App arm",
    propagatesCorruptManifestError,
  );
});
