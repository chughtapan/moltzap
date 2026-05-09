/**
 * Model-equivalence — conditional oracle over the model-derived
 * confident set (architect #195 §4.1 + #197 §2).
 *
 * Spec §5 B1: the server must produce what the model predicts when
 * the model is confident. `arbitraryConfidentCall()` draws calls via
 * the architect-literal shape `fc.constantFrom(...kept).chain(
 * arbitraryCallFor)` — probe and execution share the same generator
 * so confidence is checked on the same distribution the property
 * exercises (round-8 finding: a `.map(m => ({method: m, params: {}}))`
 * shortcut narrowed execution below the probe and hid real
 * param-dependent divergences).
 *
 * Param-invariance safety net (#197 §2.2 + §6.1): if a drawn call
 * comes back `_tag: "error"` from the model, the single-probe
 * derivation has diverged from runtime truth (applyCall became
 * param-sensitive for that method under a later draw). The property
 * raises `PropertyInvariantViolation` instead of silently short-
 * circuiting; the fix is to widen the derivation (probe with K > 1
 * samples), not extend this property.
 *
 * Current K = 1 (agents/list only). Architect #197 §2.3 notes that
 * "when K ≤ 2, the property is operating as a small number of hand-
 * picked examples; document it in JSDoc, don't pretend it's a fuzz
 * property." Widening K requires either teaching `applyCall` per-
 * method param filters (e.g. `conversations/list` confident only
 * when cursor is undefined/valid) or fixing server-side parsers that
 * error on pathological schema-valid params (e.g. `cursor: " "` →
 * SqlError on pglite cursor parsing). Tracked under #186.
 *
 * numRuns floor: `max(10, 2K)` = 10 today.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import {
  arbitraryConfidentCall,
  confidentOracleMethods,
} from "../../arbitraries/rpc.js";
import { applyCall } from "../../models/dispatch.js";
import { initialReferenceState } from "../../models/state.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  assertProperty,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "model-equivalence";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const MODEL_NUM_RUNS_FLOOR = 10;
const MODEL_RUNS_PER_CONFIDENT_METHOD = 2;

export function registerModelEquivalence(ctx: ConformanceRunContext): void {
  const K = confidentOracleMethods.length;
  const numRunsFloor = Math.max(
    MODEL_NUM_RUNS_FLOOR,
    MODEL_RUNS_PER_CONFIDENT_METHOD * K,
  );
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    `when model predicts ok, server MUST return ok (K=${K} confident methods)`,
    assertProperty(CATEGORY, PROPERTY, () =>
      fc.assert(
        fc.asyncProperty(arbitraryConfidentCall(), (call) => {
          const modelTag = applyCall(initialReferenceState, call).outcome._tag;
          if (modelTag === "error") {
            // Safety-net guard: `arbitraryConfidentCall` derived this
            // method as confident at module load. If the model now
            // disagrees, applyCall became param-sensitive for the
            // kept method and the derivation must widen. Surface
            // loudly instead of silent short-circuit.
            return Effect.runPromise(
              Effect.fail(
                new PropertyInvariantViolation({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `arbitraryConfidentCall drew ${call.method} with params ${JSON.stringify(call.params)} → model _tag: "error" — param-invariance contract broken; widen derivation to fc.sample-based check per architect #197 §2.2`,
                }),
              ),
            );
          }
          return Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* registerTestAgent({
                  baseUrl: ctx.realServer.baseUrl,
                  name: "me",
                });
                const client = yield* makeTestClient({
                  serverUrl: ctx.realServer.wsUrl,
                  agentKey: agent.apiKey,
                  agentId: agent.agentId,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                  captureCapacity: DEFAULT_CAPTURE_CAPACITY,
                });
                const outcome = yield* client
                  .sendRpc(call.definition, call.params)
                  .pipe(Effect.either);
                return Either.match(outcome, {
                  onLeft: () => "error" as const,
                  onRight: () => "ok" as const,
                });
              }),
            ).pipe(Effect.map((serverTag) => serverTag === "ok")),
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? numRunsFloor },
      ),
    ),
  );
}
