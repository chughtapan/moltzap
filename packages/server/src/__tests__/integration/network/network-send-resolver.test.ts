/**
 * Phase 8 Slice G1 integration test: AgentEndpointResolver lifecycle +
 * NetworkSendService delivery against the real WS server, observed
 * through the public CoreApp surface.
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` §2.10/§2.11.
 * Issue #426 acceptance.
 *
 * Coverage:
 *   - `network/connect` populates the resolver: `network.send` to the
 *     freshly-connected agent's address returns {@link DeliveryAck} and
 *     the recipient client decodes the typed notification on the wire.
 *   - Disconnect drains the resolver: `network.send` to the same address
 *     after close fails with {@link RecipientNotResolved}.
 *   - Multimap semantics: two simultaneous connections of the same agent
 *     each receive the payload through their own address.
 *
 * The resolver itself is not exposed on `CoreApp`; the test reaches the
 * `connId` it routes by via `coreApp.connections.agentConnections(...)`,
 * the three-arm-map agent-arm read.
 */
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  getCoreApp,
} from "../helpers.js";
import {
  registerAgent,
  connectTestClient,
  registerAndConnect,
} from "../helpers.js";
import { getBaseUrl } from "../../../test-utils/index.js";
import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import {
  agentId as protocolAgentId,
  notificationFrame,
} from "@moltzap/protocol/testing";
import {
  DeliveryAck,
  opaquePayload,
  RecipientNotResolved,
} from "../../../network/network-send.js";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

/**
 * Look up the connection id for an authenticated agent by walking the
 * `ConnectionManager`. Replaces direct resolver access — the resolver
 * is server-internal in Phase 8 G1 (issue #426 dual-DI does not
 * authorize raw resolver exposure on `CoreApp`).
 */
function connIdsForAgent(agentIdString: string): readonly string[] {
  const branded = protocolAgentId(agentIdString);
  // D #705 CP4e — read the three-arm `connectionsRef` agent arm; the
  // legacy `connections.all()` + `conn.auth` shape is gone.
  return Effect.runSync(
    getCoreApp()
      .connections.agentConnections(branded)
      .pipe(Effect.map((conns) => conns.map((conn) => conn.connId))),
  );
}

it("network.send delivers a real notification to a durable address", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-resolver");
    const [connId] = connIdsForAgent(alice.agentId);
    if (!connId) throw new Error("expected one live connection");
    // Sends are keyed by AgentId; the resolver picks one of the
    // agent's live ConnectionIds internally.
    const address = protocolAgentId(alice.agentId);

    // Real notification frame so the client's typed-bridge accepts it.
    // Asserts end-to-end wire delivery, not just the server-side write
    // ack — the `subscribe(def)` Stream only emits a frame after it
    // decodes through the validation pipeline at the client edge.
    const frame = notificationFrame(PresenceChangedNotificationDefinition, {
      agentId: protocolAgentId(alice.agentId),
      status: "online",
    });

    const ack = yield* getCoreApp().networkSendService.send(
      address,
      opaquePayload(JSON.stringify(frame)),
    );
    expect(ack).toBeInstanceOf(DeliveryAck);
    expect(ack.to).toEqual(address);

    const received = yield* awaitOneNotification(
      alice.client,
      PresenceChangedNotificationDefinition,
    );
    expect((received.params as { agentId: string }).agentId).toBe(
      alice.agentId,
    );
  }));

it("disconnect drains the resolver before subsequent send", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-drain");
    const address = protocolAgentId(alice.agentId);

    yield* alice.client.close();
    // The WS finalizer that calls `agentEndpointResolver.remove`
    // runs asynchronously after `close`; small sleep lets it settle
    // before the assertion.
    yield* Effect.sleep("100 millis");

    const exit = yield* Effect.exit(
      getCoreApp().networkSendService.send(
        address,
        opaquePayload(JSON.stringify({ noop: true })),
      ),
    );
    expect(exit).toSatisfy(Exit.isFailure);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  }));

it("two connections of the same agent share durable address routing", () =>
  Effect.gen(function* () {
    const { agentId: aId, apiKey } = yield* registerAgent(
      getBaseUrl(),
      "alice-multi",
    );
    const c1 = yield* connectTestClient({ agentId: aId, apiKey });
    const c2 = yield* connectTestClient({ agentId: aId, apiKey });

    const ids = connIdsForAgent(aId);
    expect(ids).toHaveLength(2);

    // Durable agent fan-out picks one of the agent's live connections
    // (pick-one routing). The send always succeeds when at least one
    // connection is live; both connections register under the same
    // agent in the resolver's forward map.
    const address = protocolAgentId(aId);
    const frame = notificationFrame(PresenceChangedNotificationDefinition, {
      agentId: protocolAgentId(aId),
      status: "online",
    });
    const payload = opaquePayload(JSON.stringify(frame));

    const ack1 = yield* getCoreApp().networkSendService.send(address, payload);
    expect(ack1).toBeInstanceOf(DeliveryAck);

    // Drop c1 — c2 still serves the durable address.
    yield* c1.close();
    yield* Effect.sleep("100 millis");

    const ack2 = yield* getCoreApp().networkSendService.send(address, payload);
    expect(ack2).toBeInstanceOf(DeliveryAck);
    const r2 = yield* awaitOneNotification(
      c2,
      PresenceChangedNotificationDefinition,
    );
    expect((r2.params as { agentId: string }).agentId).toBe(aId);

    yield* c2.close();
  }));
