/**
 * Boundary — server-side safety surfaces that no single RPC exercises:
 * webhook graceful-shutdown Deferred-drop and schema-exhaustive fuzz.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier E". Code uses
 * semantic names only.
 *
 * AC13 preservation: `WebhookAdapterProbe` is an opaque injected
 * interface; the consuming server-side suite wires it. No
 * `packages/server` import appears under `packages/protocol/src/testing/`.
 *
 * DEFERRED: the original SIGKILL / humanContact variant of the webhook
 * property belongs to epic #186 and is not wired here.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { allRpcMethods, arbitraryCallFor } from "../arbitraries/rpc.js";
import { makeTestClient } from "../test-client.js";
import { registerTestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  registerProperty,
} from "./registry.js";

const CATEGORY = "boundary" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;

/**
 * The webhook-shutdown probe is supplied by the consuming server-side
 * suite (which owns access to `AsyncWebhookAdapter`). Protocol code sees
 * only this opaque interface — no compile-time import of `packages/
 * server`.
 */
export interface WebhookAdapterProbe {
  /** Kick off N concurrent `send` calls; return their pending request ids. */
  readonly startPending: (
    n: number,
  ) => Promise<ReadonlyArray<{ readonly requestId: string }>>;
  /** Fire the adapter's `shutdown` Effect. */
  readonly shutdown: () => Promise<void>;
  /**
   * Resolve each pending send. Returns the observed tagged-error name
   * (e.g. `"WebhookDestroyedError"`) or `"resolved"` if the send
   * resolved cleanly before shutdown landed.
   */
  readonly awaitOutcomes: () => Promise<
    ReadonlyArray<{ readonly requestId: string; readonly outcome: string }>
  >;
}

/**
 * Webhook adapter graceful-shutdown — every pending `send` resolves
 * with the tagged `WebhookDestroyedError`, never a generic timeout,
 * never a hang.
 */
export function registerWebhookGracefulShutdown(
  ctx: ConformanceRunContext,
  probe: WebhookAdapterProbe,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "webhook-graceful-shutdown",
    "graceful shutdown completes every pending webhook send with a tagged error",
    assertProperty(CATEGORY, "webhook-graceful-shutdown", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (n) => {
          const pending = await probe.startPending(n);
          await probe.shutdown();
          const outcomes = await probe.awaitOutcomes();
          if (outcomes.length < pending.length) return false;
          return outcomes.every(
            (o) =>
              o.outcome === "WebhookDestroyedError" || o.outcome === "resolved",
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      ),
    ),
  );
}

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
        for (const method of allRpcMethods) {
          const callArb = arbitraryCallFor(method);
          const [sampled] = fc.sample(callArb, { numRuns: 1, seed: ctx.seed });
          if (sampled === undefined) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "schema-exhaustive-fuzz",
                reason: `failed to sample call for ${method}`,
              }),
            );
          }
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
      }),
    ),
  );
  void DEFAULT_CAPTURE_CAPACITY;
}
