/**
 * Coalescing regression test for `AppHost.admitAgentsAsync`.
 *
 * The admission fiber for each invited agent calls `UserService.validateUser`
 * via the shared `userValidationCache`. For N agents whose owners share the
 * same user id, that cache must collapse to a single in-flight call — any
 * higher count means the older Map.has/Map.set race slipped back in.
 *
 * The test boots a dedicated core-app with a counting `UserService`, then
 * opens one app session with three invitees whose owner_user_id is the same
 * UUID and asserts `validateUser` was called exactly once.
 */

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp, UserId } from "../../app/types.js";
import type { UserService } from "../../services/user.service.js";
import type { ConnectedAgent } from "../../test-utils/helpers.js";

let coreApp: CoreApp;
/** Observable counter — assertion target for the coalescing behavior. */
let validateCalls: Array<{ userId: UserId }>;

class CountingUserService implements UserService {
  validateUser(userId: UserId): Effect.Effect<{ valid: boolean }, never> {
    // Small async delay so concurrent admitAgent fibers overlap — without
    // the delay the Ref.modify path inside `coalesce` could still pass a
    // broken implementation because each fiber completes its work
    // synchronously before the next one reads the cache.
    return Effect.promise(async () => {
      validateCalls.push({ userId });
      await new Promise((r) => setTimeout(r, 30));
      return { valid: true };
    });
  }
}

beforeAll(async () => {
  validateCalls = [];
  const server = await startTestServer({
    userService: new CountingUserService(),
  });
  coreApp = server.coreApp;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  validateCalls = [];
  await resetTestDb();
});

function registerWithOwner(
  name: string,
  ownerUserId: string,
): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const agent = yield* registerAndConnect(name);
    const db = getKyselyDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: ownerUserId })
        .where("id", "=", agent.agentId)
        .execute(),
    );
    return agent;
  });
}

function registerTestApp(app: CoreApp, appId: string) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
  });
}

describe("AppHost: userValidationCache coalesces concurrent admissions", () => {
  it.live("calls validateUser once when 3 invitees share the same owner", () =>
    Effect.gen(function* () {
      // Stable UUID for the shared owner. The initiator is a separate user so
      // the initiator's own validate call (which happens pre-session) doesn't
      // skew the count.
      const sharedOwner = "00000000-0000-4000-a000-000000000011";
      const initiatorOwner = "00000000-0000-4000-a000-000000000010";

      const initiator = yield* registerWithOwner("cache-init", initiatorOwner);
      const inviteeA = yield* registerWithOwner("cache-inv-a", sharedOwner);
      const inviteeB = yield* registerWithOwner("cache-inv-b", sharedOwner);
      const inviteeC = yield* registerWithOwner("cache-inv-c", sharedOwner);

      registerTestApp(coreApp, "cache-test");

      // Initiator-validate call happens synchronously in createSession before
      // the admitAgentsAsync fiber forks. Record and clear it so the
      // assertion below measures only the concurrent-invitee branch.
      yield* initiator.client.sendRpc("apps/create", {
        appId: "cache-test",
        invitedAgentIds: [inviteeA.agentId, inviteeB.agentId, inviteeC.agentId],
      });

      // Wait for the async admission fiber to complete. We watch the session
      // status transition rather than sleeping a fixed duration.
      const db = getKyselyDb();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_sessions")
            .select("status")
            .where("app_id", "=", "cache-test")
            .execute(),
        );
        if (rows.length > 0 && rows[0]!.status === "active") break;
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 25)));
      }

      // One call for the initiator (distinct user), plus exactly one
      // coalesced call for the three invitees that share `sharedOwner`.
      const initiatorCalls = validateCalls.filter(
        (c) => c.userId === initiatorOwner,
      );
      const sharedCalls = validateCalls.filter((c) => c.userId === sharedOwner);

      expect(initiatorCalls).toHaveLength(1);
      expect(sharedCalls).toHaveLength(1);
    }),
  );

  it.live("does NOT coalesce validate calls across distinct owners", () =>
    Effect.gen(function* () {
      // Sanity check: the cache is keyed by userId, so three invitees with
      // three different owners should produce three calls (plus one for the
      // initiator).
      const initiatorOwner = "00000000-0000-4000-a000-000000000020";
      const ownerA = "00000000-0000-4000-a000-000000000021";
      const ownerB = "00000000-0000-4000-a000-000000000022";
      const ownerC = "00000000-0000-4000-a000-000000000023";

      const initiator = yield* registerWithOwner(
        "no-cache-init",
        initiatorOwner,
      );
      const inviteeA = yield* registerWithOwner("no-cache-a", ownerA);
      const inviteeB = yield* registerWithOwner("no-cache-b", ownerB);
      const inviteeC = yield* registerWithOwner("no-cache-c", ownerC);

      registerTestApp(coreApp, "no-cache-test");

      yield* initiator.client.sendRpc("apps/create", {
        appId: "no-cache-test",
        invitedAgentIds: [inviteeA.agentId, inviteeB.agentId, inviteeC.agentId],
      });

      const db = getKyselyDb();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_sessions")
            .select("status")
            .where("app_id", "=", "no-cache-test")
            .execute(),
        );
        if (rows.length > 0 && rows[0]!.status === "active") break;
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 25)));
      }

      expect(
        validateCalls.filter((c) => c.userId === initiatorOwner),
      ).toHaveLength(1);
      expect(validateCalls.filter((c) => c.userId === ownerA)).toHaveLength(1);
      expect(validateCalls.filter((c) => c.userId === ownerB)).toHaveLength(1);
      expect(validateCalls.filter((c) => c.userId === ownerC)).toHaveLength(1);
    }),
  );
});
