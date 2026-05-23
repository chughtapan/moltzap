import { describe, expect, it } from "vitest";

import { connectionId as makeConnectionId } from "@moltzap/protocol/testing";
import type {
  PresenceEventSink,
  PresencePublishInput,
  PresenceStatus,
} from "./presence-event-sink.js";
import { PresenceService } from "./presence.service.js";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const AGENT_C = "agent-c";
const CONN_SENDER = makeConnectionId("c-sender");
const CONN_WATCHER = makeConnectionId("c-watcher");
const CONN_W1 = makeConnectionId("c-w1");
const CONN_W2 = makeConnectionId("c-w2");
const STATUS_ONLINE = "online";
const STATUS_OFFLINE = "offline";
const STATUS_AWAY = "away";

function recordingSink(): {
  sink: PresenceEventSink;
  published: PresencePublishInput[];
} {
  const published: PresencePublishInput[] = [];
  return {
    sink: {
      publish(input) {
        published.push(input);
      },
    },
    published,
  };
}

function statusesFor(
  published: ReadonlyArray<PresencePublishInput>,
  agentId: string,
): ReadonlyArray<PresenceStatus> {
  return published.filter((p) => p.agentId === agentId).map((p) => p.status);
}

function subscribersFor(service: PresenceService, agentId: string) {
  return [...service.getSubscribers(agentId)];
}

function setupSubscribedService() {
  const r = recordingSink();
  const service = new PresenceService(r.sink);
  service.subscribe(CONN_WATCHER, [AGENT_A]);
  return { r, service };
}

describe("PresenceService", () => {
  it("setOnline publishes online", publishesOnline);
  it("setOffline publishes offline", publishesOffline);
  it(
    "re-asserting the same status does not publish (idempotent)",
    ignoresSameStatus,
  );
  it(
    "offline → online → offline → online publishes every transition",
    publishesEveryTransition,
  );
  it("update forwards excludeConnId to the sink", forwardsExcludeConnId);
  it("update without options omits excludeConnId", omitsExcludeConnId);
  it(
    "publishes even when there are no subscribers — sink decides",
    publishesWithoutSubscribers,
  );
  it(
    "subscriberConnIds reflects the registry at publish time",
    snapshotsSubscriberRegistry,
  );
  it(
    "subscribe replaces the prior set — connId removed from agents not in the new set (#487)",
    replacesPriorSubscriptionSet,
  );
  it(
    "subscribe replace-semantics does not disturb other connections' subscriptions (#487)",
    preservesOtherConnections,
  );
  it(
    "subscribe([]) unsubscribes the connection from all agents (#487)",
    unsubscribesFromAllAgents,
  );
  it(
    "subscribe is idempotent when the set is unchanged (#487)",
    subscribeIsIdempotent,
  );
  it(
    "subscribe after subscribe([]) re-establishes subscriptions cleanly (#487)",
    resubscribesAfterUnsubscribeAll,
  );
});

function publishesOnline(): void {
  const { r, service } = setupSubscribedService();
  service.setOnline(AGENT_A);

  expect(statusesFor(r.published, AGENT_A)).toEqual([STATUS_ONLINE]);
  expect(r.published[0]!.subscriberConnIds.has(CONN_WATCHER)).toBe(true);
  expect(r.published[0]!.excludeConnId).toBeUndefined();
}

function publishesOffline(): void {
  const { r, service } = setupSubscribedService();
  service.setOnline(AGENT_A);
  r.published.length = 0;

  service.setOffline(AGENT_A);

  expect(statusesFor(r.published, AGENT_A)).toEqual([STATUS_OFFLINE]);
}

function ignoresSameStatus(): void {
  const { r, service } = setupSubscribedService();
  service.setOnline(AGENT_A);
  service.setOnline(AGENT_A);

  expect(statusesFor(r.published, AGENT_A)).toEqual([STATUS_ONLINE]);
}

function publishesEveryTransition(): void {
  const { r, service } = setupSubscribedService();
  service.setOnline(AGENT_A);
  service.setOffline(AGENT_A);
  service.setOnline(AGENT_A);

  expect(statusesFor(r.published, AGENT_A)).toEqual([
    STATUS_ONLINE,
    STATUS_OFFLINE,
    STATUS_ONLINE,
  ]);
}

function forwardsExcludeConnId(): void {
  const r = recordingSink();
  const service = new PresenceService(r.sink);
  service.subscribe(CONN_SENDER, [AGENT_A]);
  service.subscribe(CONN_WATCHER, [AGENT_A]);

  service.update(AGENT_A, STATUS_AWAY, { excludeConnId: CONN_SENDER });

  expect(r.published).toHaveLength(1);
  expect(r.published[0]!.status).toBe(STATUS_AWAY);
  expect(r.published[0]!.excludeConnId).toBe(CONN_SENDER);
  // Sink owns the filtering; it receives the full subscriber set.
  expect([...r.published[0]!.subscriberConnIds].sort()).toEqual([
    CONN_SENDER,
    CONN_WATCHER,
  ]);
}

function omitsExcludeConnId(): void {
  const { r, service } = setupSubscribedService();
  service.update(AGENT_A, STATUS_AWAY);

  expect(r.published).toHaveLength(1);
  expect(r.published[0]!.excludeConnId).toBeUndefined();
}

function publishesWithoutSubscribers(): void {
  const r = recordingSink();
  const service = new PresenceService(r.sink);
  service.setOnline(AGENT_A);

  expect(r.published).toHaveLength(1);
  expect(r.published[0]!.subscriberConnIds.size).toBe(0);
}

function snapshotsSubscriberRegistry(): void {
  const r = recordingSink();
  const service = new PresenceService(r.sink);

  service.subscribe(CONN_W1, [AGENT_A]);
  service.setOnline(AGENT_A);
  service.subscribe(CONN_W2, [AGENT_A]);
  service.setOffline(AGENT_A);

  expect(r.published).toHaveLength(2);
  expect([...r.published[0]!.subscriberConnIds]).toEqual([CONN_W1]);
  expect([...r.published[1]!.subscriberConnIds].sort()).toEqual([
    CONN_W1,
    CONN_W2,
  ]);
}

function replacesPriorSubscriptionSet(): void {
  const service = new PresenceService(recordingSink().sink);
  service.subscribe(CONN_WATCHER, [AGENT_A, AGENT_B]);
  service.subscribe(CONN_WATCHER, [AGENT_B, AGENT_C]);

  expect(subscribersFor(service, AGENT_A)).toEqual([]);
  expect(subscribersFor(service, AGENT_B)).toEqual([CONN_WATCHER]);
  expect(subscribersFor(service, AGENT_C)).toEqual([CONN_WATCHER]);
}

function preservesOtherConnections(): void {
  const service = new PresenceService(recordingSink().sink);
  service.subscribe(CONN_W1, [AGENT_A, AGENT_B]);
  service.subscribe(CONN_W2, [AGENT_A, AGENT_B]);
  service.subscribe(CONN_W1, [AGENT_B]);

  expect(subscribersFor(service, AGENT_A)).toEqual([CONN_W2]);
  expect(subscribersFor(service, AGENT_B).sort()).toEqual([CONN_W1, CONN_W2]);
}

function unsubscribesFromAllAgents(): void {
  const service = new PresenceService(recordingSink().sink);
  service.subscribe(CONN_WATCHER, [AGENT_A, AGENT_B, AGENT_C]);
  service.subscribe(CONN_WATCHER, []);

  expect(subscribersFor(service, AGENT_A)).toEqual([]);
  expect(subscribersFor(service, AGENT_B)).toEqual([]);
  expect(subscribersFor(service, AGENT_C)).toEqual([]);
}

function subscribeIsIdempotent(): void {
  const service = new PresenceService(recordingSink().sink);
  service.subscribe(CONN_WATCHER, [AGENT_A, AGENT_B]);
  service.subscribe(CONN_WATCHER, [AGENT_B, AGENT_A]);

  expect(subscribersFor(service, AGENT_A)).toEqual([CONN_WATCHER]);
  expect(subscribersFor(service, AGENT_B)).toEqual([CONN_WATCHER]);
}

function resubscribesAfterUnsubscribeAll(): void {
  const service = new PresenceService(recordingSink().sink);
  service.subscribe(CONN_WATCHER, [AGENT_A]);
  service.subscribe(CONN_WATCHER, []);
  service.subscribe(CONN_WATCHER, [AGENT_B]);

  expect(subscribersFor(service, AGENT_A)).toEqual([]);
  expect(subscribersFor(service, AGENT_B)).toEqual([CONN_WATCHER]);
}
