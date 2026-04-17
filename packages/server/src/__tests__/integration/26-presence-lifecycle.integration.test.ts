import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import { registerAndConnect } from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Presence Lifecycle", () => {
  it.live("subscribe returns online status for connected agent", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-pres");
      const bob = yield* registerAndConnect("bob-pres");

      const result = (yield* alice.client.sendRpc("presence/subscribe", {
        agentIds: [bob.agentId],
      })) as { statuses: Array<{ agentId: string; status: string }> };

      expect(result.statuses).toHaveLength(1);
      expect(result.statuses[0]!.status).toBe("online");
    }),
  );

  it.live("presence/update pushes PresenceChanged to subscribers", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-away");
      const bob = yield* registerAndConnect("bob-away");

      yield* alice.client.sendRpc("presence/subscribe", {
        agentIds: [bob.agentId],
      });

      yield* bob.client.sendRpc("presence/update", { status: "away" });

      const event = yield* alice.client.waitForEvent("presence/changed");
      const data = event.data as {
        agentId: string;
        status: string;
      };
      expect(data.agentId).toBe(bob.agentId);
      expect(data.status).toBe("away");
    }),
  );

  it.live("presence cycles through online → away → offline", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-cycle");
      const bob = yield* registerAndConnect("bob-cycle");

      yield* alice.client.sendRpc("presence/subscribe", {
        agentIds: [bob.agentId],
      });

      // away
      yield* bob.client.sendRpc("presence/update", { status: "away" });
      const awayEvent = yield* alice.client.waitForEvent("presence/changed");
      expect((awayEvent.data as { status: string }).status).toBe("away");

      // back online
      yield* bob.client.sendRpc("presence/update", { status: "online" });
      const onlineEvent = yield* alice.client.waitForEvent("presence/changed");
      expect((onlineEvent.data as { status: string }).status).toBe("online");

      // offline
      yield* bob.client.sendRpc("presence/update", { status: "offline" });
      const offlineEvent = yield* alice.client.waitForEvent("presence/changed");
      expect((offlineEvent.data as { status: string }).status).toBe("offline");
    }),
  );
});
