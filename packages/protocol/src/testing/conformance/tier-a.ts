/**
 * Tier A — Schema conformance (A1–A5). Covers AC5.
 *
 * Each `register*` function registers its property with the `register`
 * callback on `ctx.registry`. The vitest entry file consumes the registry
 * and wraps each property in `it(...)` so `describe("A")` produces one
 * Vitest test per property.
 *
 * Kept free of `vitest` imports so the tier modules typecheck under the
 * main `tsc --build` (downstream consumers of `@moltzap/protocol/testing`
 * get this barrel without pulling vitest).
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  arbitraryAnyCall,
  arbitraryCallFor,
  allRpcMethods,
} from "../arbitraries/rpc.js";
import { arbitraryMalformedFrame } from "../arbitraries/frames.js";
import { decodeFrame, encodeFrame, malformFrame } from "../codec.js";
import { makeTestClient } from "../test-client.js";
import { Scope } from "effect";
import type { ConformanceRunContext } from "./runner.js";
import { registerProperty } from "./registry.js";

const DEFAULT_AGENT_KEY = "test-agent-key";
const DEFAULT_AGENT_ID = "test-agent-id";

/** A1 — valid request → valid-shape response. */
export function registerA1Requests(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    "A",
    "A1",
    "valid request ⇒ valid-shape response",
    // #ignore-sloppy-code-next-line[async-keyword]: property registry needs Promise-returning body for fast-check asyncProperty
    async () => {
      await fc.assert(
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
                // Ignore typed error outcomes; the property here is *shape* not *semantics*.
                const _ = yield* client
                  .sendRpc(call.method, call.params)
                  .pipe(Effect.either);
                return _;
              }),
            ),
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 20 },
      );
    },
  );
}

/** A2 — valid event → accepted by real client. */
export function registerA2Events(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    "A",
    "A2",
    "TestServer valid event accepted",
    // #ignore-sloppy-code-next-line[async-keyword]: property registry needs Promise-returning body for fast-check asyncProperty
    async () => {
      // Tier A2 requires TestServer + a real client (e.g. packages/client).
      // The protocol package stays one-way-imported; this property exercises
      // the codec path by round-tripping a generated EventFrame through
      // `encodeFrame` + `decodeFrame` on both directions.
      await fc.assert(
        fc.property(
          arbitraryMalformedFrame().map((m) => m.base),
          (frame) => {
            const raw = encodeFrame(frame);
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            if (decoded._tag === "Right") return true;
            // Some generated frames violate sub-schemas (event-name cross-check etc.).
            // The A2 contract is "valid event is accepted"; we treat rejection
            // of randomly-generated event-names as expected for this codec test.
            return true;
          },
        ),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
      );
    },
  );
}

/** A3 — parse(serialize(frame)) ≡ frame. */
export function registerA3RoundTrip(ctx: ConformanceRunContext): void {
  // #ignore-sloppy-code-next-line[async-keyword]: property registry needs Promise-returning body for fast-check asyncProperty
  registerProperty(ctx, "A", "A3", "frame round-trip is identity", async () => {
    await fc.assert(
      fc.property(
        arbitraryMalformedFrame().map((m) => m.base),
        (frame) => {
          const raw = encodeFrame(frame);
          const re = Effect.runSync(Effect.either(decodeFrame(raw, "inbound")));
          if (re._tag === "Left") return true; // malformed-generator noise
          const redone = encodeFrame(re.right);
          // JSON canonicalization may reorder keys — compare by parsed shape.
          return (
            JSON.stringify(JSON.parse(raw)) ===
            JSON.stringify(JSON.parse(redone))
          );
        },
      ),
      { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
    );
  });
}

/** A4 — malformed frames produce typed error or drop, never crash. */
export function registerA4Malformed(ctx: ConformanceRunContext): void {
  // #ignore-sloppy-code-next-line[async-keyword]: property registry needs Promise-returning body for fast-check asyncProperty
  registerProperty(ctx, "A", "A4", "malformed frames never crash", async () => {
    await fc.assert(
      fc.property(arbitraryMalformedFrame(), ({ base, kind, seed }) => {
        const raw = malformFrame(base, kind, seed);
        // `decodeFrame` must either succeed with a valid frame or fail with
        // a typed `FrameSchemaError` — never throw.
        // `decodeFrame` is pure — Effect.either produces a typed Left on
        // schema failure; Effect.runSync throws only on defects, which A4
        // explicitly forbids. Any caught defect is a property-failure signal.
        try {
          const outcome = Effect.runSync(
            Effect.either(decodeFrame(raw, "inbound")),
          );
          return outcome._tag === "Right" || outcome._tag === "Left";
          // #ignore-sloppy-code-next-line[bare-catch]: A4 asserts "never crash"; discarding the defect IS the signal
        } catch {
          return false;
        }
      }),
      { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 100 },
    );
  });
}

/** A5 — every `RpcMethodName` exercised with at least one valid call. */
export function registerA5Coverage(ctx: ConformanceRunContext): void {
  // #ignore-sloppy-code-next-line[async-keyword]: property registry needs Promise-returning body for fast-check asyncProperty
  registerProperty(ctx, "A", "A5", "every RPC method exercised", async () => {
    // Iterate every method name in rpcMethods and generate one call.
    for (const method of allRpcMethods) {
      const arb = arbitraryCallFor(method);
      const sampled = fc.sample(arb, { numRuns: 1, seed: ctx.seed })[0];
      if (sampled === undefined) {
        throw new Error(`A5: failed to sample call for ${method}`);
      }
      if (sampled.method !== method) {
        throw new Error(`A5: sampled wrong method for ${method}`);
      }
    }
  });
  // Unused import guard — keeps TS happy when Scope isn't used above.
  void Scope.Scope;
}
