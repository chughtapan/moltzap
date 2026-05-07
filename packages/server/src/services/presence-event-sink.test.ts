import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";

import { ConnectionManager, type MoltZapConnection } from "../ws/connection.js";
import { unusedJsonRpcClient } from "../ws/connection.test-utils.js";
import {
  createConnectionFanOutPresenceEventSink,
  type PresencePublishInput,
} from "./presence-event-sink.js";

const AGENT_A_UUID = makeAgentId("00000000-0000-4000-8000-00000000a9e7");

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
    jsonRpcClient: unusedJsonRpcClient(),
  };
  return { conn, writes };
}

function presenceEventsFor(
  writes: string[],
  agentId: string,
): Array<{ agentId: string; status: string }> {
  return writes
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter(
      (frame) => frame["method"] === PresenceChangedNotificationDefinition.name,
    )
    .map((frame) => frame["params"] as { agentId: string; status: string })
    .filter((data) => data.agentId === agentId);
}

/** Drain Effect.runFork-scheduled writes — one macrotask suffices. */
async function flushFibers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function publishInput(opts: {
  agentId: PresencePublishInput["agentId"];
  status: PresencePublishInput["status"];
  subscriberConnIds: Iterable<string>;
  excludeConnId?: string;
}): PresencePublishInput {
  return {
    agentId: opts.agentId,
    status: opts.status,
    subscriberConnIds: new Set(opts.subscriberConnIds),
    excludeConnId: opts.excludeConnId,
  };
}

describe("ConnectionFanOutPresenceEventSink", () => {
  it("writes presence/changed to every subscriber", async () => {
    const connections = new ConnectionManager();
    const a = makeConn("c-a");
    const b = makeConn("c-b");
    connections.add(a.conn);
    connections.add(b.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: "online",
        subscriberConnIds: ["c-a", "c-b"],
      }),
    );
    await flushFibers();

    const expected = [{ agentId: AGENT_A_UUID, status: "online" }];
    expect(presenceEventsFor(a.writes, AGENT_A_UUID)).toEqual(expected);
    expect(presenceEventsFor(b.writes, AGENT_A_UUID)).toEqual(expected);
  });

  it("skips excludeConnId", async () => {
    const connections = new ConnectionManager();
    const sender = makeConn("c-sender");
    const watcher = makeConn("c-watcher");
    connections.add(sender.conn);
    connections.add(watcher.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: "away",
        subscriberConnIds: ["c-sender", "c-watcher"],
        excludeConnId: "c-sender",
      }),
    );
    await flushFibers();

    expect(presenceEventsFor(sender.writes, AGENT_A_UUID)).toHaveLength(0);
    expect(presenceEventsFor(watcher.writes, AGENT_A_UUID)).toEqual([
      { agentId: AGENT_A_UUID, status: "away" },
    ]);
  });

  it("short-circuits on empty subscriberConnIds", async () => {
    const connections = new ConnectionManager();
    const watcher = makeConn("c-watcher");
    connections.add(watcher.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: "online",
        subscriberConnIds: [],
      }),
    );
    await flushFibers();

    expect(presenceEventsFor(watcher.writes, AGENT_A_UUID)).toHaveLength(0);
  });

  it("silently skips a subscriber connId not in ConnectionManager", async () => {
    const connections = new ConnectionManager();
    const live = makeConn("c-live");
    connections.add(live.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    expect(() =>
      sink.publish(
        publishInput({
          agentId: AGENT_A_UUID,
          status: "offline",
          subscriberConnIds: ["c-live", "c-stale"],
        }),
      ),
    ).not.toThrow();
    await flushFibers();

    expect(presenceEventsFor(live.writes, AGENT_A_UUID)).toEqual([
      { agentId: AGENT_A_UUID, status: "offline" },
    ]);
  });
});
