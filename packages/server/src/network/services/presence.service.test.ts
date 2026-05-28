/* eslint-disable agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks -- regression-only suite: each case names a contractual transition (online/working/offline, dedup, fast-reconnect race). PresenceStatus literals are contractual wire values; making them imports would lose the regression intent. Vitest `describe`/`it` + Effect.gen naturally nest 4 deep. */

/**
 * Unit tests for the `PresenceService` status engine.
 *
 * Covers state derivation (online / working / offline), subscriber
 * fan-out, dedup discipline, and the named regression cases:
 * redundant-connect-while-working, fast-reconnect-during-abandon,
 * concurrent-grant-during-fast-reconnect, and lease callbacks on
 * absent / stale-connection entries.
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
  readonly sent: string[];
}

function makeHarness(): Harness {
  const connections = new ConnectionManager();
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
  return { connections, sent };
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
 * Drain the microtask queue so the fire-and-forget `Effect.runFork`
 * writes to the recording connection have landed before assertions
 * read `sent`. The `Effect.yieldNow` calls relinquish the fiber so any
 * forked writes that resolved synchronously have a chance to
 * interleave.
 */
const drainMicrotasks: Effect.Effect<void> = Effect.gen(function* () {
  yield* Effect.yieldNow();
  yield* Effect.yieldNow();
});

/**
 * Build the service, register the given subscriber-watch sets, then run
 * `body`. The subscriber registry and the status engine are one
 * `PresenceService` instance, so subscriptions and transitions exercise
 * the same object.
 */
function withHarness<A>(
  h: Harness,
  watch: ReadonlyArray<readonly [ConnectionId, ReadonlyArray<AgentId>]>,
  body: (presence: PresenceService) => Effect.Effect<A>,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    const presence = yield* PresenceService.make(h.connections);
    for (const [connId, agentIds] of watch) {
      presence.subscribe(connId, agentIds);
    }
    return yield* body(presence);
  });
}

describe("PresenceService — state derivation", () => {
  it("WS connect emits `online`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("lease GRANTED while connected emits `working`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "working" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("lease CONSUMED while connected emits `online`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("WS close emits `offline`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "offline" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("offline");
      }),
    );
  });

  it("`statusMany` returns per-agent snapshots; unknown agents resolve to `offline`", () => {
    const h = makeHarness();
    return withHarness(h, [], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        const result = yield* presence.statusMany([AGENT_A, AGENT_B]);
        expect(result).toEqual([
          { agentId: AGENT_A, status: "working" },
          { agentId: AGENT_B, status: "offline" },
        ]);
      }),
    );
  });
});

describe("PresenceService — dedup discipline", () => {
  it("second GRANTED lease while already `working` emits NO `presence/changed`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("only the LAST CONSUMED lease drops the agent back to `online`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        yield* presence.onLeaseActiveEnd(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
      }),
    );
  });
});

describe("PresenceService — regression cases", () => {
  it("redundant-connect-while-working: second onAgentConnect with the same connId is a no-op", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("fast-reconnect-during-abandon: stale lease callbacks audit without re-emitting", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("concurrent-grant-during-fast-reconnect: stale onLeaseActiveBegin audits without re-emitting", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("lease begin / end on an absent entry audits LeaseBeginAfterDisconnect / LeaseEndAfterDisconnect", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* presence.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("offline");
      }),
    );
  });

  it("stale-disconnect (connId not in liveConns) is a silent no-op", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });
});

describe("PresenceService — subscriber-snapshot semantics", () => {
  it("only subscribed connections receive `presence/changed`", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_B]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
      }),
    );
  });
});

// `AgentEndpointResolver` supports an agent holding multiple
// simultaneous WS connections (web tab + CLI + mobile). A second
// simultaneous connect must NOT be treated as a "reconnect" that
// clears the agent's active leases and emits a spurious `online` while
// the agent is still busy on the original conn. These tests pin the
// multi-conn semantics down.
describe("PresenceService — multi-connection-per-agent", () => {
  it("a second simultaneous WS connection does NOT clobber an active lease (status stays `working`, no emission)", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        // Sanity: status is now `working` (subscriber has seen online
        // + working).
        const statusOnConn1 = yield* presence.statusOf(AGENT_A);
        expect(statusOnConn1).toBe("working");
        h.sent.length = 0;
        // Agent opens a second simultaneous connection (e.g. mobile
        // app while the CLI lease is still active).
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        // The new connection does not affect the agent's lease set.
        // Status stays `working`; the dedup rule elides emission
        // (working → working).
        expect(h.sent).toEqual([]);
        const statusAfterSecondConnect = yield* presence.statusOf(AGENT_A);
        expect(statusAfterSecondConnect).toBe("working");
      }),
    );
  });

  it("losing a non-leased simultaneous connection leaves the agent `working` on the other conn (no emission)", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        // Agent connects on conn1 + conn2; lease granted on conn1
        // only.
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        // conn2 disconnects; it had no leases, so no per-conn lease
        // bucket to drop, and conn1's lease is still active.
        yield* presence.onAgentDisconnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("working");
      }),
    );
  });

  it("losing the leased connection while another conn is still live flips status to `online` (lease cleaned up per-conn)", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        h.sent.length = 0;
        // conn1 disconnects — its lease bucket is dropped wholesale
        // so the agent's working count drains to zero. conn2 is
        // still live, so the agent stays online (not offline).
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("online");
      }),
    );
  });

  it("losing the last live connection flips status to `offline` (entry deleted)", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        // Disconnect conn1 first — second conn still live, no
        // emission.
        yield* presence.onAgentDisconnect(AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        // Disconnect conn2 — entry is now empty, emit offline.
        yield* presence.onAgentDisconnect(AGENT_A, CONN_2);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "offline" },
        ]);
        const status = yield* presence.statusOf(AGENT_A);
        expect(status).toBe("offline");
      }),
    );
  });

  it("active leases on different simultaneous conns are tracked independently", () => {
    const h = makeHarness();
    return withHarness(h, [[SUBSCRIBER, [AGENT_A]]], (presence) =>
      Effect.gen(function* () {
        yield* presence.onAgentConnect(AGENT_A, CONN_1);
        yield* presence.onAgentConnect(AGENT_A, CONN_2);
        yield* presence.onLeaseActiveBegin(LEASE_X, AGENT_A, CONN_1);
        yield* presence.onLeaseActiveBegin(LEASE_Y, AGENT_A, CONN_2);
        yield* drainMicrotasks;
        h.sent.length = 0;
        // Releasing LEASE_X on conn1 keeps the agent working (LEASE_Y
        // is still active on conn2).
        yield* presence.onLeaseActiveEnd(LEASE_X, AGENT_A, CONN_1);
        yield* drainMicrotasks;
        expect(h.sent).toEqual([]);
        const stillWorking = yield* presence.statusOf(AGENT_A);
        expect(stillWorking).toBe("working");
        // Releasing LEASE_Y drains the active set; agent flips to
        // online.
        yield* presence.onLeaseActiveEnd(LEASE_Y, AGENT_A, CONN_2);
        yield* drainMicrotasks;
        expect(decodeFrames(h.sent)).toEqual([
          { agentId: AGENT_A, status: "online" },
        ]);
      }),
    );
  });
});
