import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAgent,
  connectTestClient,
  registerAndConnect,
  trackClient,
  type ConnectedAgent,
} from "../helpers.js";
import { getBaseUrl } from "../../../test-utils/index.js";
import {
  PresenceSubscribe,
  PresenceUpdate,
  PresenceChangedNotificationDefinition,
} from "@moltzap/protocol";

const it = effectIt.live;

const PRESENCE_DEV_OWNER = "00000000-0000-4000-8000-000000000470";
const STATUS_ONLINE = "online";
const STATUS_AWAY = "away";
const STATUS_OFFLINE = "offline";

beforeAll(() =>
  Effect.runPromise(
    startTestServerEffect({ devModeUserId: PRESENCE_DEV_OWNER }),
  ),
);
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function presenceStatus(event: { params: unknown }): string {
  return (event.params as { status: string }).status;
}

function presenceAgentId(event: { params: unknown }): string {
  return (event.params as { agentId: string }).agentId;
}

function waitPresenceChanged(agent: ConnectedAgent) {
  return agent.client.waitForNotification(
    PresenceChangedNotificationDefinition,
  );
}

function subscribe(watcher: ConnectedAgent, agentIds: string[]) {
  return watcher.client.sendRpc(PresenceSubscribe, {
    agentIds,
  }) as Effect.Effect<{
    statuses: Array<{ agentId: string; status: string }>;
  }>;
}

function updatePresence(agent: ConnectedAgent, status: string) {
  return agent.client.sendRpc(PresenceUpdate, { status });
}

function subscribeReturnsOnlineForConnectedAgent() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-pres");
    const bob = yield* registerAndConnect("bob-pres");
    const result = yield* subscribe(alice, [bob.agentId]);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]?.status).toBe(STATUS_ONLINE);
  });
}

function updatePushesPresenceChanged() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-away");
    const bob = yield* registerAndConnect("bob-away");
    yield* subscribe(alice, [bob.agentId]);

    yield* updatePresence(bob, STATUS_AWAY);
    const event = yield* waitPresenceChanged(alice);
    expect(presenceAgentId(event)).toBe(bob.agentId);
    expect(presenceStatus(event)).toBe(STATUS_AWAY);
  });
}

function cyclesThroughPresenceStatuses() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-cycle");
    const bob = yield* registerAndConnect("bob-cycle");
    yield* subscribe(alice, [bob.agentId]);

    yield* updatePresence(bob, STATUS_AWAY);
    expect(presenceStatus(yield* waitPresenceChanged(alice))).toBe(STATUS_AWAY);

    yield* updatePresence(bob, STATUS_ONLINE);
    expect(presenceStatus(yield* waitPresenceChanged(alice))).toBe(
      STATUS_ONLINE,
    );

    yield* updatePresence(bob, STATUS_OFFLINE);
    expect(presenceStatus(yield* waitPresenceChanged(alice))).toBe(
      STATUS_OFFLINE,
    );
  });
}

function connectBroadcastsOnline() {
  return Effect.gen(function* () {
    const watcher = yield* registerAndConnect("watcher-connect");
    const target = yield* registerAgent(getBaseUrl(), "target-connect");
    const sub = yield* subscribe(watcher, [target.agentId]);
    expect(sub.statuses[0]?.status).toBe(STATUS_OFFLINE);

    const targetClient = yield* connectTestClient({
      agentId: target.agentId,
      apiKey: target.apiKey,
    });
    trackClient(targetClient);

    const event = yield* waitPresenceChanged(watcher);
    expect(presenceAgentId(event)).toBe(target.agentId);
    expect(presenceStatus(event)).toBe(STATUS_ONLINE);
  });
}

function disconnectBroadcastsOffline() {
  return Effect.gen(function* () {
    const watcher = yield* registerAndConnect("watcher-disconnect");
    const target = yield* registerAndConnect("target-disconnect");
    yield* subscribe(watcher, [target.agentId]);

    yield* target.client.close();
    const event = yield* waitPresenceChanged(watcher);
    expect(presenceAgentId(event)).toBe(target.agentId);
    expect(presenceStatus(event)).toBe(STATUS_OFFLINE);
  });
}

describe("Presence lifecycle snapshots", () => {
  it(
    "subscribe returns online status for connected agent",
    subscribeReturnsOnlineForConnectedAgent,
  );
});

describe("Presence lifecycle updates", () => {
  it(
    "presence/update pushes PresenceChanged to subscribers",
    updatePushesPresenceChanged,
  );
  it(
    "presence cycles through online, away, offline",
    cyclesThroughPresenceStatuses,
  );
});

describe("Presence lifecycle connection transitions", () => {
  it(
    "network/connect broadcasts presence/changed online to subscribers",
    connectBroadcastsOnline,
  );
  it(
    "disconnect broadcasts presence/changed offline to subscribers",
    disconnectBroadcastsOffline,
  );
});
