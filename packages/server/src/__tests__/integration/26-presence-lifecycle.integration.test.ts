import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import {
  registerAgent,
  connectTestClient,
  registerAndConnect,
  trackClient,
} from "./helpers.js";
import { getBaseUrl } from "../../test-utils/index.js";

import {
  PresenceSubscribe,
  PresenceUpdate,
  PresenceChangedNotificationDefinition,
} from "@moltzap/protocol";

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

      const result = (yield* alice.client.sendRpc(PresenceSubscribe, {
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

      yield* alice.client.sendRpc(PresenceSubscribe, {
        agentIds: [bob.agentId],
      });

      yield* bob.client.sendRpc(PresenceUpdate, { status: "away" });

      const event = yield* alice.client.waitForNotification(
        PresenceChangedNotificationDefinition,
      );
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

      yield* alice.client.sendRpc(PresenceSubscribe, {
        agentIds: [bob.agentId],
      });

      // away
      yield* bob.client.sendRpc(PresenceUpdate, { status: "away" });
      const awayEvent = yield* alice.client.waitForNotification(
        PresenceChangedNotificationDefinition,
      );
      expect((awayEvent.data as { status: string }).status).toBe("away");

      // back online
      yield* bob.client.sendRpc(PresenceUpdate, { status: "online" });
      const onlineEvent = yield* alice.client.waitForNotification(
        PresenceChangedNotificationDefinition,
      );
      expect((onlineEvent.data as { status: string }).status).toBe("online");

      // offline
      yield* bob.client.sendRpc(PresenceUpdate, { status: "offline" });
      const offlineEvent = yield* alice.client.waitForNotification(
        PresenceChangedNotificationDefinition,
      );
      expect((offlineEvent.data as { status: string }).status).toBe("offline");
    }),
  );

  // arena#252 — connect/disconnect transitions publish presence/changed.
  it.live(
    "auth/connect broadcasts presence/changed online to subscribers",
    () =>
      Effect.gen(function* () {
        const watcher = yield* registerAndConnect("watcher-connect");

        // Subscribe BEFORE target connects so the snapshot reads offline.
        const target = yield* registerAgent(getBaseUrl(), "target-connect");
        const sub = (yield* watcher.client.sendRpc(PresenceSubscribe, {
          agentIds: [target.agentId],
        })) as { statuses: Array<{ agentId: string; status: string }> };
        expect(sub.statuses[0]!.status).toBe("offline");

        const targetClient = yield* connectTestClient({
          agentId: target.agentId,
          apiKey: target.apiKey,
        });
        trackClient(targetClient);

        const event = yield* watcher.client.waitForNotification(
          PresenceChangedNotificationDefinition,
        );
        const data = event.data as { agentId: string; status: string };
        expect(data.agentId).toBe(target.agentId);
        expect(data.status).toBe("online");
      }),
  );

  it.live("disconnect broadcasts presence/changed offline to subscribers", () =>
    Effect.gen(function* () {
      const watcher = yield* registerAndConnect("watcher-disconnect");
      const target = yield* registerAndConnect("target-disconnect");

      // Subscribe AFTER target is online; close is the only offline trigger.
      yield* watcher.client.sendRpc(PresenceSubscribe, {
        agentIds: [target.agentId],
      });

      yield* target.client.close();

      const event = yield* watcher.client.waitForNotification(
        PresenceChangedNotificationDefinition,
      );
      const data = event.data as { agentId: string; status: string };
      expect(data.agentId).toBe(target.agentId);
      expect(data.status).toBe("offline");
    }),
  );
});
