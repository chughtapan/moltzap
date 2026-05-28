/* eslint-disable agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks -- regression-only suite per architect plan #706 §8: each case names a contractual transition (online/working/offline, dedup, fast-reconnect race). PresenceStatus literals are contractual wire values pinned by the plan; making them imports would lose the regression intent. Vitest `describe`/`it` + Effect.gen naturally nest 4 deep. */

/**
 * Unit tests for the `PresenceProjection` module (architect plan #706,
 * impl-staff sub-issue #712).
 *
 * Covers state derivation (online / working / offline), subscriber
 * fan-out, dedup discipline, and the named regression cases from §8 of
 * the v6+ plan: redundant-connect-while-working,
 * fast-reconnect-during-abandon, concurrent-grant-during-fast-reconnect,
 * and lease callbacks on absent / stale-connection entries.
 */

import { describe, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { LeaseId } from "@moltzap/protocol";

import {
  ConnectionManager,
  type MoltZapConnection,
} from "../../transport/connection.js";
import { PresenceService } from "./presence.service.js";
import {
  makePresenceProjection,
  type PresenceProjection,
} from "./presence-projection.js";

const it = effectIt.live;

const AGENT_A = "agent-a" as AgentId;
const AGENT_B = "agent-b" as AgentId;
const CONN_1 = "conn-1" as ConnectionId;
const CONN_2 = "conn-2" as ConnectionId;
const SUBSCRIBER = "subscriber-conn" as ConnectionId;
const LEASE_X = "lease-x" as LeaseId;
const LEASE_Y = "lease-y" as LeaseId;

interface Harness {
  readonly connections: ConnectionManager;
  readonly subscribers: PresenceService;
  readonly sent: string[];
}

function makeHarness(): Harness {
  const connections = new ConnectionManager();
  const subscribers = new PresenceService();
  const sent: string[] = [];
  const subscriberConn: MoltZapConnection = {
    id: SUBSCRIBER,
    write: (raw: string) =>
      Effect.sync(() => {
        sent.push(raw);
      }),
    shutdown: Effect.void,
    auth: null,
    lastPong: 0,
    conversationIds: new Set(),
    mutedConversations: new Set(),
    originator: {} as MoltZapConnection["originator"],
  };
  connections.add(subscriberConn);
  return { connections, subscribers, sent };
}

interface DecodedFrame {
  readonly agentId: string;
  readonly status: string;
}

function decodeFrames(
  sent: ReadonlyArray<string>,
): ReadonlyArray<DecodedFrame> {
  return sent.map((raw) => {
    const parsed = JSON.parse(raw) as {
      readonly method: string;
      readonly params: { readonly agentId: string; readonly status: string };
    };
    if (parsed.method !== PresenceChangedNotificationDefinition.name) {
      throw new Error(`unexpected wire frame method: ${parsed.method}`);
    }
    return { agentId: parsed.params.agentId, status: parsed.params.status };
  });
}

/**
 * Drain the microtask queue so the projection's fire-and-forget
 * `Effect.runFork` writes to the recording connection have landed
 * before assertions read `sent`. The `Effect.yieldNow` calls
 * relinquish the fiber so any forked writes that resolved
 * synchronously have a chance to interleave.
 */
const drainMicrotasks: Effect.Effect<void> = Effect.gen(function* () {
  yield* Effect.yieldNow();
  yield* Effect.yieldNow();
});

function withHarness<A>(
  h: Harness,
  body: (projection: PresenceProjection) => Effect.Effect<A>,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    const projection = yield* makePresenceProjection({
      connections: h.connections,
      subscribers: h.subscribers,
    });
    return yield* body(projection);
  });
}

describe("PresenceProjection — state derivation", () => {
  it("WS connect emits `online`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("lease GRANTED while connected emits `working`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "working" },
        ]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("lease CONSUMED while connected emits `online`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("WS close emits `offline`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "offline" },
        ]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("offline");
      }),
    );
  });

  it("`statusMany` returns per-agent snapshots; unknown agents resolve to `offline`", () => {
    const h = makeHarness();
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        const result = yield* projection.statusMany([AGENT_A, AGENT_B]);
        expect(result).toEqual([
          { agentId: AGENT_A, status: "working" },
          { agentId: AGENT_B, status: "offline" },
        ]);
      }),
    );
  });
});

describe("PresenceProjection — dedup discipline", () => {
  it("second GRANTED lease while already `working` emits NO `presence/changed`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("only the LAST CONSUMED lease drops the agent back to `online`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        yield* projection.onLeaseActiveEnd(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
      }),
    );
  });
});

describe("PresenceProjection — regression cases (architect plan §8)", () => {
  it("redundant-connect-while-working: second onAgentConnect with the same connId is a no-op", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("fast-reconnect-during-abandon: stale lease callbacks audit without re-emitting", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* projection.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        yield* projection.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("concurrent-grant-during-fast-reconnect: stale onLeaseActiveBegin audits without re-emitting", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* projection.onAgentDisconnect(AGENT_A, CONN_1);
        yield* projection.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("lease begin / end on an absent entry audits LeaseBeginAfterDisconnect / LeaseEndAfterDisconnect", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* projection.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("offline");
      }),
    );
  });

  it("stale-disconnect (entry.connId mismatch) is a silent no-op", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_A]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* projection.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* projection.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });
});

describe("PresenceProjection — subscriber-snapshot semantics", () => {
  it("only subscribed connections receive `presence/changed`", () => {
    const h = makeHarness();
    h.subscribers.subscribe(SUBSCRIBER, [AGENT_B]);
    return withHarness(h, (projection) =>
      Effect.gen(function* () {
        yield* projection.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
      }),
    );
  });
});
