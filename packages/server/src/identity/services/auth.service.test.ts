import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Effect } from "effect";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import {
  AuthService,
  CLAIM_NOT_FOUND,
  CLAIM_OWNER_MISMATCH,
  CLAIM_SUCCESS,
} from "./auth.service.js";
import type { AgentId } from "@moltzap/protocol/identity";

const SYSTEM_USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

let harness: PgliteHarness;

const it = effectIt.effect;

const UNKNOWN_CLAIM_TOKEN = "MZAP-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";

function ownerForAgent(agentId: AgentId) {
  return Effect.tryPromise({
    try: () =>
      harness.db
        .selectFrom("agents")
        .select(["owner_user_id"])
        .where("id", "=", agentId)
        .executeTakeFirstOrThrow(),
    catch: (cause) => cause,
  });
}

function bindsOwnerWhenTokenMatches() {
  return Effect.gen(function* () {
    const svc = new AuthService(harness.db);
    const reg = yield* svc.registerAgent({ name: "alice" });
    expect(reg.claimToken).toMatch(/^MZAP-/);

    const result = yield* svc.claimAgent({
      claimToken: reg.claimToken,
      ownerUserId: SYSTEM_USER,
    });
    expect(result._tag).toBe(CLAIM_SUCCESS);
    if (result._tag !== CLAIM_SUCCESS) throw new Error("unreachable");
    expect(result.agentId).toBe(reg.agentId);
    expect(result.ownerUserId).toBe(SYSTEM_USER);
    expect(result.alreadyClaimed).toBe(false);

    const after = yield* ownerForAgent(reg.agentId);
    expect(after.owner_user_id).toBe(SYSTEM_USER);
  });
}

function reclaimsSameOwnerIdempotently() {
  return Effect.gen(function* () {
    const svc = new AuthService(harness.db);
    const reg = yield* svc.registerAgent({ name: "bob" });

    const first = yield* svc.claimAgent({
      claimToken: reg.claimToken,
      ownerUserId: SYSTEM_USER,
    });
    if (first._tag !== CLAIM_SUCCESS) throw new Error("first claim failed");
    expect(first.alreadyClaimed).toBe(false);

    const second = yield* svc.claimAgent({
      claimToken: reg.claimToken,
      ownerUserId: SYSTEM_USER,
    });
    if (second._tag !== CLAIM_SUCCESS) throw new Error("re-claim failed");
    expect(second.agentId).toBe(reg.agentId);
    expect(second.ownerUserId).toBe(SYSTEM_USER);
    expect(second.alreadyClaimed).toBe(true);
  });
}

function rejectsClaimOwnerMismatch() {
  return Effect.gen(function* () {
    const svc = new AuthService(harness.db);
    const reg = yield* svc.registerAgent({ name: "carol" });

    yield* svc.claimAgent({
      claimToken: reg.claimToken,
      ownerUserId: SYSTEM_USER,
    });
    const conflict = yield* svc.claimAgent({
      claimToken: reg.claimToken,
      ownerUserId: OTHER_USER,
    });
    expect(conflict._tag).toBe(CLAIM_OWNER_MISMATCH);

    // Ownership unchanged after the rejected attempt.
    const row = yield* ownerForAgent(reg.agentId);
    expect(row.owner_user_id).toBe(SYSTEM_USER);
  });
}

function rejectsUnknownClaimToken() {
  return Effect.gen(function* () {
    const svc = new AuthService(harness.db);
    const result = yield* svc.claimAgent({
      claimToken: UNKNOWN_CLAIM_TOKEN,
      ownerUserId: SYSTEM_USER,
    });
    expect(result._tag).toBe(CLAIM_NOT_FOUND);
  });
}

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

describe("AuthService.claimAgent (#486)", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);

  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "binds owner_user_id when token matches an unclaimed agent",
    bindsOwnerWhenTokenMatches,
  );

  it(
    "idempotent: re-claim with same (token, ownerUserId) returns alreadyClaimed=true",
    reclaimsSameOwnerIdempotently,
  );

  it(
    "rejects with CLAIM_OWNER_MISMATCH when a different ownerUserId attempts to claim a claimed agent",
    rejectsClaimOwnerMismatch,
  );

  it(
    "rejects with CLAIM_NOT_FOUND for a token that matches no agent",
    rejectsUnknownClaimToken,
  );
});
