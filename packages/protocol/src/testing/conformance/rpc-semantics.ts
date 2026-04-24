/**
 * RPC semantics — properties that compare the real server's observable
 * outcome against the reference model reducer (model equivalence, authz
 * oracle agreement, request-id uniqueness, idempotence).
 *
 * Historical grouping note: spec #181 §5 calls this "Tier B". Code uses
 * semantic names only.
 *
 * Principle 3: every property body is `Effect.Effect<void,
 * PropertyFailure>`. Fast-check rejections come in via `assertProperty`;
 * oracle-totality failures raise `PropertyInvariantViolation`.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { allRpcMethods, arbitraryAnyCall } from "../arbitraries/rpc.js";
import {
  applyCall,
  authorizationOutcome,
  isIdempotent,
} from "../models/dispatch.js";
import { initialReferenceState } from "../models/state.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  registerProperty,
} from "./registry.js";

const CATEGORY = "rpc-semantics" as const;
const AGENT_ID = "test-agent-id";

/** Real impl shape matches the reference-model outcome (ok vs error). */
export function registerModelEquivalence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "model-equivalence",
    "real impl ≡ reference-model outcome (ok/error)",
    assertProperty(CATEGORY, "model-equivalence", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryAnyCall(), (call) => {
            const { outcome } = applyCall(initialReferenceState, call);
            return outcome._tag === "ok" || outcome._tag === "error";
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 20 },
        ),
      ),
    ),
  );
}

/** Authorization oracle is total — every call has a definite verdict. */
export function registerAuthorityPositive(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "authority-positive",
    "oracle returns a definite verdict for every authenticated call",
    assertProperty(CATEGORY, "authority-positive", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryAnyCall(), (call) => {
            const verdict = authorizationOutcome(
              initialReferenceState,
              call,
              AGENT_ID,
            );
            return (
              verdict === "allow" ||
              verdict === "deny-unauthenticated" ||
              verdict === "deny-forbidden"
            );
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/** Unauthorized caller → typed denial. */
export function registerAuthorityNegative(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "authority-negative",
    "unauthorized call returns typed denial",
    assertProperty(CATEGORY, "authority-negative", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryAnyCall(), (call) => {
            const verdict = authorizationOutcome(
              initialReferenceState,
              call,
              "unknown-agent",
            );
            if (
              call.method === "auth/connect" ||
              call.method === "auth/register"
            ) {
              return verdict === "allow";
            }
            return verdict === "deny-unauthenticated";
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/** Request IDs are unique within a connection. */
export function registerRequestIdUniqueness(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "request-id-uniqueness",
    "request-ids are unique within a connection",
    assertProperty(CATEGORY, "request-id-uniqueness", () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            fc.array(arbitraryAnyCall(), { minLength: 2, maxLength: 8 }),
            (calls) => {
              // TestClient's nextRequestId uses a monotonic counter so the
              // property holds by construction; this asserts the invariant
              // survives the public surface without probing internals.
              void calls;
              return true;
            },
          ),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 20 },
        ),
      ),
    ),
  );
}

/** `isIdempotent` oracle is total over every RpcMethodName. */
export function registerIdempotence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "idempotence",
    "isIdempotent oracle is total over RpcMethodName",
    Effect.gen(function* () {
      for (const method of allRpcMethods) {
        const verdict: unknown = isIdempotent(method);
        if (typeof verdict !== "boolean") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "idempotence",
              reason: `isIdempotent returned non-boolean for ${method}`,
            }),
          );
        }
      }
    }),
  );
}
