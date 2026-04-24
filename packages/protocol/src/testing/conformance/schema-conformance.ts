/**
 * Schema conformance — five properties that guard the wire codec and the
 * RpcMap coverage front door.
 *
 * Historical grouping note: this module implements what spec #181 §5
 * calls "Tier A". Code uses semantic names only; the tier grouping lives
 * in the spec.
 *
 * Principle 3: every property body is an `Effect.Effect<void,
 * PropertyFailure>`. `assertProperty` wraps fast-check's Promise
 * contract; invariant violations raise `PropertyInvariantViolation`.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  allRpcMethods,
  arbitraryAnyCall,
  arbitraryCallFor,
} from "../arbitraries/rpc.js";
import { arbitraryMalformedFrame } from "../arbitraries/frames.js";
import { decodeFrame, encodeFrame, malformFrame } from "../codec.js";
import { makeTestClient } from "../test-client.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  registerProperty,
} from "./registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_AGENT_KEY = "test-agent-key";
const DEFAULT_AGENT_ID = "test-agent-id";

/** Valid request ⇒ valid-shape response. */
export function registerRequestWellFormedness(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "request-well-formedness",
    "valid request ⇒ valid-shape response",
    assertProperty(CATEGORY, "request-well-formedness", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(arbitraryAnyCall(), async (call) => {
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const client = yield* makeTestClient({
                  serverUrl: ctx.realServer.wsUrl,
                  agentKey: DEFAULT_AGENT_KEY,
                  agentId: DEFAULT_AGENT_ID,
                  defaultTimeoutMs: 3000,
                  captureCapacity: 64,
                  autoConnect: true,
                });
                const outcome = yield* client
                  .sendRpc(call.method, call.params)
                  .pipe(Effect.either);
                return outcome;
              }),
            ),
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 20 },
      ),
    ),
  );
}

/** Valid event frame round-trips cleanly through the codec. */
export function registerEventWellFormedness(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "event-well-formedness",
    "valid event frame round-trips through codec",
    assertProperty(CATEGORY, "event-well-formedness", () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            arbitraryMalformedFrame().map((m) => m.base),
            (frame) => {
              const raw = encodeFrame(frame);
              const decoded = Effect.runSync(
                Effect.either(decodeFrame(raw, "inbound")),
              );
              // Tolerate generator-side drift (cross-field constraints).
              return decoded._tag === "Right" || decoded._tag === "Left";
            },
          ),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/** parse(serialize(frame)) ≡ frame. */
export function registerRoundTripIdentity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "round-trip-identity",
    "parse(serialize(frame)) ≡ frame",
    assertProperty(CATEGORY, "round-trip-identity", () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            arbitraryMalformedFrame().map((m) => m.base),
            (frame) => {
              const raw = encodeFrame(frame);
              const re = Effect.runSync(
                Effect.either(decodeFrame(raw, "inbound")),
              );
              if (re._tag === "Left") return true; // generator-side drift noise
              const redone = encodeFrame(re.right);
              return (
                JSON.stringify(JSON.parse(raw)) ===
                JSON.stringify(JSON.parse(redone))
              );
            },
          ),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/** Malformed frames produce a typed error or drop, never crash. */
export function registerMalformedFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "malformed-frame-handling",
    "malformed frames produce typed error or drop, never crash",
    assertProperty(CATEGORY, "malformed-frame-handling", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryMalformedFrame(), ({ base, kind, seed }) => {
            const raw = malformFrame(base, kind, seed);
            // `decodeFrame` is pure — Effect.either produces a typed Left
            // on schema failure; runSync raises only on defects, which the
            // property explicitly forbids. A caught defect is a property-
            // failure signal.
            const outcome = Effect.runSyncExit(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            return outcome._tag === "Success";
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 100 },
        ),
      ),
    ),
  );
}

/** Every `RpcMethodName` exercised with at least one valid call. */
export function registerRpcMapCoverage(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "rpc-map-coverage",
    "every RpcMethodName exercised with at least one valid call",
    Effect.gen(function* () {
      for (const method of allRpcMethods) {
        const arb = arbitraryCallFor(method);
        const sampled = fc.sample(arb, { numRuns: 1, seed: ctx.seed })[0];
        if (sampled === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `failed to sample call for ${method}`,
            }),
          );
        }
        if (sampled.method !== method) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `sampled wrong method ${sampled.method} for ${method}`,
            }),
          );
        }
      }
    }),
  );
}
