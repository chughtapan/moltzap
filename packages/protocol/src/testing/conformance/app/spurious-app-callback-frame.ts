/**
 * Spurious appCallback responses do not crash or poison the server.
 * Architect plan §3.3 + §1.7: the server's `appCallbackPending` map keys
 * on the request id IT allocated; an inbound appCallback response with no
 * matching pending entry is dropped silently and the connection stays
 * responsive to subsequent traffic.
 *
 * Property body opens a real TestClient, injects a JSON-RPC response
 * frame whose `id` matches no request the server tracks (any client-
 * minted id is necessarily unmatched), then issues a follow-up RPC. A
 * conforming server keeps the WS open and replies; a non-conforming
 * server crashes, disconnects, or stops responding — the follow-up
 * surfaces the divergence as a typed liveness failure.
 */
import { Effect, Either } from "effect";
import { AgentsList } from "@moltzap/protocol/identity";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "spurious-app-callback-frame-handling";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const SPURIOUS_RESPONSE_ID = "spurious-no-pending-557";

export function registerSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "stray appCallback response with no matching pending ⇒ server drops & stays alive",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "spurious-frame",
        });
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        });

        // Inject a JSON-RPC response frame whose `id` is not in the
        // server's `appCallbackPending` map. Any id the client mints is
        // necessarily unmatched (the server only stores ids it allocates
        // when sending app-callback requests of its own).
        const injection = yield* client
          .sendRawFrame({
            jsonrpc: "2.0",
            id: SPURIOUS_RESPONSE_ID,
            result: {},
          })
          .pipe(Effect.either);
        yield* Either.match(injection, {
          onLeft: (err) =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `transport faulted writing spurious frame: ${err._tag}`,
              }),
            ),
          onRight: () => Effect.void,
        });

        // Liveness probe — a follow-up RPC must succeed. Dropped frame
        // ⇒ probe returns Right; crash/disconnect/silence ⇒ probe
        // surfaces a typed transport or timeout error and the property
        // reports the divergence.
        const probe = yield* client.sendRpc(AgentsList, {}).pipe(Effect.either);
        return yield* Either.match(probe, {
          onLeft: (err) =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `liveness probe after spurious frame failed: ${err._tag}`,
              }),
            ),
          onRight: () => Effect.void,
        });
      }),
    ).pipe(
      Effect.catchTags({
        TestingAgentRegistrationError: (e) =>
          Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: PROPERTY,
              reason: `register: ${e.body}`,
            }),
          ),
        TestingTransportIoError: (e) =>
          Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: PROPERTY,
              reason: `transport io setup: ${String(e.cause)}`,
            }),
          ),
        TestingTransportClosedError: (e) =>
          Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: PROPERTY,
              reason: `transport closed during setup: ${e.reason}`,
            }),
          ),
        TestingRpcResponseError: (e) =>
          Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: PROPERTY,
              reason: `rpc response error during setup: ${e.message}`,
            }),
          ),
      }),
    ).pipe(Effect.withSpan("registerSpuriousAppCallbackFrameHandling")),
  );
}
