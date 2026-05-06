import { describe, expect, it } from "vitest";

import type {
  PresenceEventSink,
  PresencePublishInput,
  PresenceStatus,
} from "./presence-event-sink.js";
import { PresenceService } from "./presence.service.js";

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

describe("PresenceService", () => {
  it("setOnline publishes online", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-watcher", ["agent-a"]);

    service.setOnline("agent-a");

    expect(statusesFor(r.published, "agent-a")).toEqual(["online"]);
    expect(r.published[0]!.subscriberConnIds.has("c-watcher")).toBe(true);
    expect(r.published[0]!.excludeConnId).toBeUndefined();
  });

  it("setOffline publishes offline", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-watcher", ["agent-a"]);
    service.setOnline("agent-a");
    r.published.length = 0;

    service.setOffline("agent-a");

    expect(statusesFor(r.published, "agent-a")).toEqual(["offline"]);
  });

  it("re-asserting the same status does not publish (idempotent)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-watcher", ["agent-a"]);

    service.setOnline("agent-a");
    service.setOnline("agent-a");

    expect(statusesFor(r.published, "agent-a")).toEqual(["online"]);
  });

  it("offline → online → offline → online publishes every transition", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-watcher", ["agent-a"]);

    service.setOnline("agent-a");
    service.setOffline("agent-a");
    service.setOnline("agent-a");

    expect(statusesFor(r.published, "agent-a")).toEqual([
      "online",
      "offline",
      "online",
    ]);
  });

  it("update forwards excludeConnId to the sink", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-sender", ["agent-a"]);
    service.subscribe("c-watcher", ["agent-a"]);

    service.update("agent-a", "away", { excludeConnId: "c-sender" });

    expect(r.published).toHaveLength(1);
    expect(r.published[0]!.status).toBe("away");
    expect(r.published[0]!.excludeConnId).toBe("c-sender");
    // Sink owns the filtering; it receives the full subscriber set.
    expect([...r.published[0]!.subscriberConnIds].sort()).toEqual([
      "c-sender",
      "c-watcher",
    ]);
  });

  it("update without options omits excludeConnId", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);
    service.subscribe("c-watcher", ["agent-a"]);

    service.update("agent-a", "away");

    expect(r.published).toHaveLength(1);
    expect(r.published[0]!.excludeConnId).toBeUndefined();
  });

  it("publishes even when there are no subscribers — sink decides", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.setOnline("agent-a");

    expect(r.published).toHaveLength(1);
    expect(r.published[0]!.subscriberConnIds.size).toBe(0);
  });

  it("subscriberConnIds reflects the registry at publish time", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-w1", ["agent-a"]);
    service.setOnline("agent-a");
    service.subscribe("c-w2", ["agent-a"]);
    service.setOffline("agent-a");

    expect(r.published).toHaveLength(2);
    expect([...r.published[0]!.subscriberConnIds]).toEqual(["c-w1"]);
    expect([...r.published[1]!.subscriberConnIds].sort()).toEqual([
      "c-w1",
      "c-w2",
    ]);
  });

  it("subscribe replaces the prior set — connId removed from agents not in the new set (#487)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-watcher", ["agent-a", "agent-b"]);
    service.subscribe("c-watcher", ["agent-b", "agent-c"]);

    expect([...service.getSubscribers("agent-a")]).toEqual([]);
    expect([...service.getSubscribers("agent-b")]).toEqual(["c-watcher"]);
    expect([...service.getSubscribers("agent-c")]).toEqual(["c-watcher"]);
  });

  it("subscribe replace-semantics does not disturb other connections' subscriptions (#487)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-w1", ["agent-a", "agent-b"]);
    service.subscribe("c-w2", ["agent-a", "agent-b"]);
    service.subscribe("c-w1", ["agent-b"]);

    expect([...service.getSubscribers("agent-a")]).toEqual(["c-w2"]);
    expect([...service.getSubscribers("agent-b")].sort()).toEqual([
      "c-w1",
      "c-w2",
    ]);
  });

  it("subscribe([]) unsubscribes the connection from all agents (#487)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-watcher", ["agent-a", "agent-b", "agent-c"]);
    service.subscribe("c-watcher", []);

    expect([...service.getSubscribers("agent-a")]).toEqual([]);
    expect([...service.getSubscribers("agent-b")]).toEqual([]);
    expect([...service.getSubscribers("agent-c")]).toEqual([]);
  });

  it("subscribe is idempotent when the set is unchanged (#487)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-watcher", ["agent-a", "agent-b"]);
    service.subscribe("c-watcher", ["agent-b", "agent-a"]);

    expect([...service.getSubscribers("agent-a")]).toEqual(["c-watcher"]);
    expect([...service.getSubscribers("agent-b")]).toEqual(["c-watcher"]);
  });

  it("subscribe after subscribe([]) re-establishes subscriptions cleanly (#487)", () => {
    const r = recordingSink();
    const service = new PresenceService(r.sink);

    service.subscribe("c-watcher", ["agent-a"]);
    service.subscribe("c-watcher", []);
    service.subscribe("c-watcher", ["agent-b"]);

    expect([...service.getSubscribers("agent-a")]).toEqual([]);
    expect([...service.getSubscribers("agent-b")]).toEqual(["c-watcher"]);
  });
});
