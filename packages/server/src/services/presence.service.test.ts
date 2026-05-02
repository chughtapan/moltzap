/**
 * Unit tests for PresenceService — pin the invariant that every status
 * transition (setOnline/setOffline/update) publishes `presence/changed`
 * to subscribers, with the broadcast idempotent on re-assert and emitted
 * on each side of a reverse race. Closes arena#252.
 */

import { describe, expect, it } from "vitest";
import { Effect, HashMap, Ref } from "effect";

import { EventNames } from "@moltzap/protocol";

import {
  ConnectionManager,
  type MoltZapConnection,
  type S2cPendingMap,
} from "../ws/connection.js";
import { PresenceService } from "./presence.service.js";

interface Capture {
  conn: MoltZapConnection;
  writes: string[];
}

function makeConn(connId: string): Capture {
  const writes: string[] = [];
  const conn: MoltZapConnection = {
    id: connId,
    write: (raw) =>
      Effect.sync(() => {
        writes.push(raw);
      }),
    shutdown: Effect.void,
    auth: null,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    s2cPending: Ref.unsafeMake<S2cPendingMap>(HashMap.empty()),
    s2cRequestCounter: Ref.unsafeMake(0),
  };
  return { conn, writes };
}

function presenceEventsFor(
  writes: string[],
  agentId: string,
): Array<{ status: string }> {
  return writes
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter(
      (frame) =>
        frame["type"] === "event" &&
        frame["event"] === EventNames.PresenceChanged,
    )
    .map((frame) => frame["data"] as { agentId: string; status: string })
    .filter((data) => data.agentId === agentId);
}

/** Drain Effect.runFork-scheduled writes so the capture array reflects
 * them before assertions. One macrotask is sufficient. */
async function flushFibers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("PresenceService — broadcast on connect/disconnect", () => {
  it("setOnline broadcasts presence/changed to subscribers", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    connections.add(watcher.conn);

    const service = new PresenceService(connections);
    service.subscribe(watcher.conn.id, ["agent-a"]);
    service.setOnline("agent-a");
    await flushFibers();

    const events = presenceEventsFor(watcher.writes, "agent-a");
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("online");
  });

  it("setOffline broadcasts presence/changed to subscribers", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    connections.add(watcher.conn);

    const service = new PresenceService(connections);
    service.setOnline("agent-a"); // arrive at "online"
    service.subscribe(watcher.conn.id, ["agent-a"]);
    await flushFibers();
    watcher.writes.length = 0;

    service.setOffline("agent-a");
    await flushFibers();

    const events = presenceEventsFor(watcher.writes, "agent-a");
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("offline");
  });

  it("setOnline twice fires only one event (idempotent on re-assert)", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    connections.add(watcher.conn);

    const service = new PresenceService(connections);
    service.subscribe(watcher.conn.id, ["agent-a"]);

    service.setOnline("agent-a");
    service.setOnline("agent-a");
    await flushFibers();

    const events = presenceEventsFor(watcher.writes, "agent-a");
    expect(events).toHaveLength(1);
  });

  it("reverse race (offline → online quickly) emits both transitions", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    connections.add(watcher.conn);

    const service = new PresenceService(connections);
    service.subscribe(watcher.conn.id, ["agent-a"]);

    service.setOnline("agent-a"); // offline → online
    service.setOffline("agent-a"); // online → offline
    service.setOnline("agent-a"); // offline → online (reconnect storm)
    await flushFibers();

    const events = presenceEventsFor(watcher.writes, "agent-a");
    expect(events.map((e) => e.status)).toEqual([
      "online",
      "offline",
      "online",
    ]);
  });

  it("update from RPC excludes the sender connection from broadcast", async () => {
    const connections = new ConnectionManager();
    const sender = makeConn("c-sender");
    const watcher = makeConn("c-watcher");
    connections.add(sender.conn);
    connections.add(watcher.conn);

    const service = new PresenceService(connections);
    service.subscribe(sender.conn.id, ["agent-a"]);
    service.subscribe(watcher.conn.id, ["agent-a"]);

    service.update("agent-a", "away", sender.conn.id);
    await flushFibers();

    expect(presenceEventsFor(sender.writes, "agent-a")).toHaveLength(0);
    expect(presenceEventsFor(watcher.writes, "agent-a")).toEqual([
      { agentId: "agent-a", status: "away" },
    ]);
  });

  it("does not broadcast when there are no subscribers for the agent", async () => {
    const connections = new ConnectionManager();
    const bystander = makeConn("c-bystander");
    connections.add(bystander.conn);

    const service = new PresenceService(connections);
    // bystander is not subscribed to agent-a
    service.setOnline("agent-a");
    await flushFibers();

    expect(presenceEventsFor(bystander.writes, "agent-a")).toHaveLength(0);
  });

  it("dropped subscriber connection is skipped silently", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    // Subscribed but never added to ConnectionManager — mirrors the race
    // where a subscriber drops between subscribe and the next transition.
    const service = new PresenceService(connections);
    service.subscribe(watcher.conn.id, ["agent-a"]);

    expect(() => service.setOnline("agent-a")).not.toThrow();
    await flushFibers();
    expect(presenceEventsFor(watcher.writes, "agent-a")).toHaveLength(0);
  });
});
