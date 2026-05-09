/**
 * Schema-exhaustive fuzz — for every wire method, draws arbitrary
 * valid params, sends through a real TestClient, and asserts the server
 * survives. Reuses a single TestClient across the whole iteration so
 * the suite doesn't open 40+ sockets in serial; each method runs behind
 * the same post-call liveness probe.
 *
 * Iterates every wire method. Failure on any single method halts
 * the property with a `PropertyInvariantViolation` naming the offender,
 * so artifacts are actionable.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { allRpcMethods, arbitraryCallFor } from "../../arbitraries/rpc.js";
import { AgentsList } from "../../../identity/methods.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";

const CATEGORY = "boundary" as const;
const PROPERTY = "schema-exhaustive-fuzz";
const DEFAULT_TIMEOUT_MS = 3000;
const FUZZ_CAPTURE_CAPACITY_PER_METHOD = 4;

export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "every wire method drawn → server survives & stays responsive",
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
                name: PROPERTY,
                reason: `register agent: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity:
            allRpcMethods.length * FUZZ_CAPTURE_CAPACITY_PER_METHOD,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
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
                name: PROPERTY,
                reason: `failed to sample call for ${method}`,
              }),
            );
          }
          for (const sampled of samples) {
            yield* client
              .sendRpc(sampled.definition, sampled.params)
              .pipe(Effect.either);
            // Post-fuzz liveness: a follow-up RPC must return a typed
            // response. Accepting any `Left` would let a timeout or
            // transport-close slip through as "server alive" — which is
            // exactly what the property must reject. Require the post
            // call to SUCCEED; timeouts are failures here.
            const post = yield* client
              .sendRpc(AgentsList, {})
              .pipe(Effect.either);
            const postFailure = leftOrNull(post);
            if (postFailure !== null) {
              return yield* Effect.fail(
                new PropertyInvariantViolation({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `server became unresponsive after ${method} (post-call ${postFailure._tag})`,
                }),
              );
            }
          }
        }
      }),
    ),
  );
}
