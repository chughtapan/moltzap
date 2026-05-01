/**
 * Boundary — server-side safety surfaces that no single RPC exercises.
 * Historical grouping note: spec #181 §5 calls this "Tier E". Code uses
 * semantic names only.
 *
 * The s2c-RPC fail-on-app-disconnect invariant (the equivalent of the
 * deleted webhook-graceful-shutdown property under B.1's awaitable RPC
 * transport) is owned by B.8 / sub-issue #305.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { allRpcMethods, arbitraryCallFor } from "../arbitraries/rpc.js";
import { makeTestClient } from "../test-client.js";
import { registerTestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import { PropertyInvariantViolation, registerProperty } from "./registry.js";

const CATEGORY = "boundary" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;

/**
 * Schema-exhaustive fuzz — for every `RpcMethodName`, draws arbitrary
 * valid params, sends through a real TestClient, and asserts the server
 * survives. Reuses a single TestClient across the whole iteration so
 * the suite doesn't open 40+ sockets in serial; each method runs behind
 * the same post-call liveness probe.
 *
 * Iterates every `RpcMethodName`. Failure on any single method halts
 * the property with a `PropertyInvariantViolation` naming the offender,
 * so artifacts are actionable.
 */
export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "schema-exhaustive-fuzz",
    "every RpcMethodName drawn → server survives & stays responsive",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "fuzz",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "schema-exhaustive-fuzz",
                reason: `register agent: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: allRpcMethods.length * 4,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "schema-exhaustive-fuzz",
                reason: `client acquire: ${String(e)}`,
              }),
          ),
        );
        const samplesPerMethod = ctx.opts.numRuns ?? 1;
        for (const method of allRpcMethods) {
          const callArb = arbitraryCallFor(method);
          const samples = fc.sample(callArb, {
            numRuns: samplesPerMethod,
            seed: ctx.seed,
          });
          if (samples.length === 0) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "schema-exhaustive-fuzz",
                reason: `failed to sample call for ${method}`,
              }),
            );
          }
          for (const sampled of samples) {
            yield* client
              .sendRpc(sampled.method, sampled.params)
              .pipe(Effect.either);
            // Post-fuzz liveness: a follow-up RPC must return a typed
            // response. Accepting any `Left` would let a timeout or
            // transport-close slip through as "server alive" — which is
            // exactly what the property must reject. Require the post
            // call to SUCCEED; timeouts are failures here.
            const post = yield* client
              .sendRpc("agents/list", {})
              .pipe(Effect.either);
            if (post._tag !== "Right") {
              return yield* Effect.fail(
                new PropertyInvariantViolation({
                  category: CATEGORY,
                  name: "schema-exhaustive-fuzz",
                  reason: `server became unresponsive after ${method} (post-call ${post._tag === "Left" ? post.left._tag : "unknown"})`,
                }),
              );
            }
          }
        }
      }),
    ),
  );
  void DEFAULT_CAPTURE_CAPACITY;
}
