import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const SYSTEM_USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";

let harness: PgliteHarness;

describe("AuthService.claimAgent (#486)", () => {
  beforeEach(async () => {
    harness = await makePgliteHarness();
  }, PGLITE_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await harness.close();
  }, PGLITE_HOOK_TIMEOUT_MS);

  it("binds owner_user_id when token matches an unclaimed agent", async () => {
    const svc = new AuthService(harness.db);
    const reg = await Effect.runPromise(svc.registerAgent({ name: "alice" }));
    expect(reg.claimToken).toMatch(/^MZAP-/);

    const result = await Effect.runPromise(
      svc.claimAgent({ claimToken: reg.claimToken, ownerUserId: SYSTEM_USER }),
    );
    expect(result._tag).toBe(CLAIM_SUCCESS);
    if (result._tag !== CLAIM_SUCCESS) throw new Error("unreachable");
    expect(result.agentId).toBe(reg.agentId);
    expect(result.ownerUserId).toBe(SYSTEM_USER);
    expect(result.alreadyClaimed).toBe(false);

    const after = await harness.db
      .selectFrom("agents")
      .select(["owner_user_id"])
      .where("id", "=", reg.agentId)
      .executeTakeFirstOrThrow();
    expect(after.owner_user_id).toBe(SYSTEM_USER);
  });

  it("idempotent: re-claim with same (token, ownerUserId) returns alreadyClaimed=true", async () => {
    const svc = new AuthService(harness.db);
    const reg = await Effect.runPromise(svc.registerAgent({ name: "bob" }));

    const first = await Effect.runPromise(
      svc.claimAgent({ claimToken: reg.claimToken, ownerUserId: SYSTEM_USER }),
    );
    if (first._tag !== CLAIM_SUCCESS) throw new Error("first claim failed");
    expect(first.alreadyClaimed).toBe(false);

    const second = await Effect.runPromise(
      svc.claimAgent({ claimToken: reg.claimToken, ownerUserId: SYSTEM_USER }),
    );
    if (second._tag !== CLAIM_SUCCESS) throw new Error("re-claim failed");
    expect(second.agentId).toBe(reg.agentId);
    expect(second.ownerUserId).toBe(SYSTEM_USER);
    expect(second.alreadyClaimed).toBe(true);
  });

  it("rejects with CLAIM_OWNER_MISMATCH when a different ownerUserId attempts to claim a claimed agent", async () => {
    const svc = new AuthService(harness.db);
    const reg = await Effect.runPromise(svc.registerAgent({ name: "carol" }));

    await Effect.runPromise(
      svc.claimAgent({ claimToken: reg.claimToken, ownerUserId: SYSTEM_USER }),
    );
    const conflict = await Effect.runPromise(
      svc.claimAgent({ claimToken: reg.claimToken, ownerUserId: OTHER_USER }),
    );
    expect(conflict._tag).toBe(CLAIM_OWNER_MISMATCH);

    // Ownership unchanged after the rejected attempt.
    const row = await harness.db
      .selectFrom("agents")
      .select(["owner_user_id"])
      .where("id", "=", reg.agentId)
      .executeTakeFirstOrThrow();
    expect(row.owner_user_id).toBe(SYSTEM_USER);
  });

  it("rejects with CLAIM_NOT_FOUND for a token that matches no agent", async () => {
    const svc = new AuthService(harness.db);
    const result = await Effect.runPromise(
      svc.claimAgent({
        claimToken: "MZAP-DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
        ownerUserId: SYSTEM_USER,
      }),
    );
    expect(result._tag).toBe(CLAIM_NOT_FOUND);
  });
});
