import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect } from "effect";

import {
  PresenceChangedNotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import {
  agentId as makeAgentId,
  connectionId as makeConnectionId,
  decodeFrame,
  type AnyFrame,
} from "@moltzap/protocol/testing";

import {
  ConnectionManager,
  type MoltZapConnection,
} from "../../transport/connection.js";
import { unusedOriginator } from "../../transport/connection.test-utils.js";
import {
  createConnectionFanOutPresenceEventSink,
  type PresencePublishInput,
} from "./presence-event-sink.js";

const it = effectIt.effect;

const AGENT_A_UUID = makeAgentId("00000000-0000-4000-8000-00000000a9e7");
const CONN_A = makeConnectionId("c-a");
const CONN_B = makeConnectionId("c-b");
const CONN_SENDER = makeConnectionId("c-sender");
const CONN_WATCHER = makeConnectionId("c-watcher");
const CONN_LIVE = makeConnectionId("c-live");
const CONN_STALE = makeConnectionId("c-stale");
const STATUS_ONLINE = "online";
const STATUS_AWAY = "away";
const STATUS_OFFLINE = "offline";

type PresenceChangedParams = NotificationParamsOf<
  typeof PresenceChangedNotificationDefinition
>;

interface Capture {
  conn: MoltZapConnection;
  writes: string[];
}

function makeConn(
  connId: import("@moltzap/protocol/network").ConnectionId,
): Capture {
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
    originator: unusedOriginator(),
  };
  return { conn, writes };
}

function presenceEventsFor(
  writes: readonly string[],
  agentId: string,
): Effect.Effect<PresenceChangedParams[], unknown> {
  return Effect.gen(function* () {
    const events: PresenceChangedParams[] = [];
    for (const raw of writes) {
      const frame = yield* decodeFrame(raw, "outbound");
      const params = presenceParamsFor(frame, agentId);
      if (params) events.push(params);
    }
    return events;
  });
}

function presenceParamsFor(
  frame: AnyFrame,
  agentId: string,
): PresenceChangedParams | null {
  if (
    "method" in frame &&
    frame.method === PresenceChangedNotificationDefinition.name &&
    PresenceChangedNotificationDefinition.validateParams(frame.params) &&
    frame.params.agentId === agentId
  ) {
    return frame.params;
  }
  return null;
}

const flushFibers: Effect.Effect<void> = Effect.async((resume) => {
  setImmediate(() => {
    resume(Effect.void);
  });
});

function publishInput(opts: {
  agentId: PresencePublishInput["agentId"];
  status: PresencePublishInput["status"];
  subscriberConnIds: Iterable<import("@moltzap/protocol/network").ConnectionId>;
  excludeConnId?: import("@moltzap/protocol/network").ConnectionId;
}): PresencePublishInput {
  return {
    agentId: opts.agentId,
    status: opts.status,
    subscriberConnIds: new Set(opts.subscriberConnIds),
    excludeConnId: opts.excludeConnId,
  };
}

describe("ConnectionFanOutPresenceEventSink", () => {
  it("writes presence/changed to every subscriber", writesToEverySubscriber);
  it("skips excludeConnId", skipsExcludedConnection);
  it(
    "short-circuits on empty subscriberConnIds",
    shortCircuitsEmptySubscribers,
  );
  it(
    "silently skips a subscriber connId not in ConnectionManager",
    skipsMissingConnection,
  );
});

function writesToEverySubscriber() {
  return Effect.gen(function* () {
    const connections = new ConnectionManager();
    const a = makeConn(CONN_A);
    const b = makeConn(CONN_B);
    connections.add(a.conn);
    connections.add(b.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: STATUS_ONLINE,
        subscriberConnIds: [CONN_A, CONN_B],
      }),
    );
    yield* flushFibers;

    const expected = [{ agentId: AGENT_A_UUID, status: STATUS_ONLINE }];
    expect(yield* presenceEventsFor(a.writes, AGENT_A_UUID)).toEqual(expected);
    expect(yield* presenceEventsFor(b.writes, AGENT_A_UUID)).toEqual(expected);
  });
}

function skipsExcludedConnection() {
  return Effect.gen(function* () {
    const connections = new ConnectionManager();
    const sender = makeConn(CONN_SENDER);
    const watcher = makeConn(CONN_WATCHER);
    connections.add(sender.conn);
    connections.add(watcher.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: STATUS_AWAY,
        subscriberConnIds: [CONN_SENDER, CONN_WATCHER],
        excludeConnId: CONN_SENDER,
      }),
    );
    yield* flushFibers;

    expect(yield* presenceEventsFor(sender.writes, AGENT_A_UUID)).toHaveLength(
      0,
    );
    expect(yield* presenceEventsFor(watcher.writes, AGENT_A_UUID)).toEqual([
      { agentId: AGENT_A_UUID, status: STATUS_AWAY },
    ]);
  });
}

function shortCircuitsEmptySubscribers() {
  return Effect.gen(function* () {
    const connections = new ConnectionManager();
    const watcher = makeConn(CONN_WATCHER);
    connections.add(watcher.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    sink.publish(
      publishInput({
        agentId: AGENT_A_UUID,
        status: STATUS_ONLINE,
        subscriberConnIds: [],
      }),
    );
    yield* flushFibers;

    expect(yield* presenceEventsFor(watcher.writes, AGENT_A_UUID)).toHaveLength(
      0,
    );
  });
}

function skipsMissingConnection() {
  return Effect.gen(function* () {
    const connections = new ConnectionManager();
    const live = makeConn(CONN_LIVE);
    connections.add(live.conn);

    const sink = createConnectionFanOutPresenceEventSink({ connections });
    expect(() =>
      sink.publish(
        publishInput({
          agentId: AGENT_A_UUID,
          status: STATUS_OFFLINE,
          subscriberConnIds: [CONN_LIVE, CONN_STALE],
        }),
      ),
    ).not.toThrow();
    yield* flushFibers;

    expect(yield* presenceEventsFor(live.writes, AGENT_A_UUID)).toEqual([
      { agentId: AGENT_A_UUID, status: STATUS_OFFLINE },
    ]);
  });
}
