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
 * `connId` it routes by via `coreApp.connections.all()`, which is the
 * existing public surface.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  getCoreApp,
} from "./helpers.js";
import {
  registerAgent,
  connectTestClient,
  registerAndConnect,
} from "./helpers.js";
import { getBaseUrl } from "../../test-utils/index.js";
import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import { agentId as protocolAgentId } from "@moltzap/protocol/testing";
import { makeEndpointAddress } from "@moltzap/protocol/network";
import {
  opaquePayload,
  RecipientNotResolved,
} from "../../network/network-send.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

/**
 * Look up the connection id for an authenticated agent by walking the
 * `ConnectionManager`. Replaces direct resolver access — the resolver
 * is server-internal in Phase 8 G1 (issue #426 dual-DI does not
 * authorize raw resolver exposure on `CoreApp`).
 */
function connIdsForAgent(agentIdString: string): readonly string[] {
  const branded = protocolAgentId(agentIdString);
  return getCoreApp()
    .connections.all()
    .filter((conn) => conn.auth?.agentId === branded)
    .map((conn) => conn.id);
}

describe("AgentEndpointResolver + network.send lifecycle (Phase 8 G1)", () => {
  it.live(
    "network.send delivers a real notification to a connected agent via durable address",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-resolver");
        const [connId] = connIdsForAgent(alice.agentId);
        if (!connId) throw new Error("expected one live connection");
        // Phase 9b consumer-migration (sub-issue #460 amendment):
        // `agent-conn` retired. Sends use the durable
        // `tm:agent:<agentId>` form; the resolver picks one of the
        // agent's live ConnectionIds internally.
        const address = makeEndpointAddress("agent", alice.agentId);

        // Real notification frame so the client's typed-bridge accepts it.
        // Asserts end-to-end wire delivery, not just the server-side write
        // ack — `waitForNotification` only fires after the frame decodes
        // through the validation pipeline at the client edge.
        const frame = PresenceChangedNotificationDefinition.encode({
          agentId: protocolAgentId(alice.agentId),
          status: "online",
        });

        const ack = yield* getCoreApp().networkSendService.send(
          address,
          opaquePayload(JSON.stringify(frame)),
        );
        expect(ack._tag).toBe("DeliveryAck");
        expect(ack.to).toEqual(address);

        const received = yield* alice.client.waitForNotification(
          PresenceChangedNotificationDefinition,
        );
        expect((received.params as { agentId: string }).agentId).toBe(
          alice.agentId,
        );
      }),
  );

  it.live(
    "disconnect drains the resolver: subsequent send fails with RecipientNotResolved",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-drain");
        const address = makeEndpointAddress("agent", alice.agentId);

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
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(RecipientNotResolved);
          }
        }
      }),
  );

  it.live(
    "multimap: two connections of the same agent both share the durable address routing",
    () =>
      Effect.gen(function* () {
        const { agentId: aId, apiKey } = yield* registerAgent(
          getBaseUrl(),
          "alice-multi",
        );
        const c1 = yield* connectTestClient({ agentId: aId, apiKey });
        const c2 = yield* connectTestClient({ agentId: aId, apiKey });

        const ids = connIdsForAgent(aId);
        expect(ids).toHaveLength(2);

        // Phase 9b: durable address fans out to one of the agent's live
        // connections (pick-one routing). The send always succeeds when
        // at least one connection is live; both connections register
        // under the same agent in the resolver's forward map.
        const address = makeEndpointAddress("agent", aId);
        const frame = PresenceChangedNotificationDefinition.encode({
          agentId: protocolAgentId(aId),
          status: "online",
        });
        const payload = opaquePayload(JSON.stringify(frame));

        const ack1 = yield* getCoreApp().networkSendService.send(
          address,
          payload,
        );
        expect(ack1._tag).toBe("DeliveryAck");

        // Drop c1 — c2 still serves the durable address.
        yield* c1.close();
        yield* Effect.sleep("100 millis");

        const ack2 = yield* getCoreApp().networkSendService.send(
          address,
          payload,
        );
        expect(ack2._tag).toBe("DeliveryAck");
        const r2 = yield* c2.waitForNotification(
          PresenceChangedNotificationDefinition,
        );
        expect((r2.params as { agentId: string }).agentId).toBe(aId);

        yield* c2.close();
      }),
  );
});
