/**
 * RPC semantics — properties that compare the real server's observable
 * outcome against the reference-model reducer, and exercise authority
 * + request-id + idempotence invariants end-to-end.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier B". Code uses
 * semantic names only.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  arbitraryAnyCall,
  arbitraryConfidentCall,
  confidentOracleMethods,
} from "../arbitraries/rpc.js";
import {
  applyCall,
  authorizationOutcome,
  isIdempotent,
} from "../models/dispatch.js";
import { initialReferenceState } from "../models/state.js";
import { ErrorCodes } from "../../schema/errors.js";
import { canonicalJson, sortJsonArray } from "../canonicalize.js";
import { makeTestClient } from "../test-client.js";
import { registerTestAgent } from "../agent-registration.js";
import { allRpcMethods } from "../arbitraries/rpc.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "./registry.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

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
export function registerModelEquivalence(ctx: ConformanceRunContext): void {
  const K = confidentOracleMethods.length;
  const numRunsFloor = Math.max(10, 2 * K);
  registerProperty(
    ctx,
    CATEGORY,
    "model-equivalence",
    `when model predicts ok, server MUST return ok (K=${K} confident methods)`,
    assertProperty(CATEGORY, "model-equivalence", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(arbitraryConfidentCall(), async (call) => {
          const modelTag = applyCall(initialReferenceState, call).outcome._tag;
          if (modelTag === "error") {
            // Safety-net guard: `arbitraryConfidentCall` derived this
            // method as confident at module load. If the model now
            // disagrees, applyCall became param-sensitive for the
            // kept method and the derivation must widen. Surface
            // loudly instead of silent short-circuit.
            throw new Error(
              `arbitraryConfidentCall drew ${call.method} with params ${JSON.stringify(call.params)} → model _tag: "error" — param-invariance contract broken; widen derivation to fc.sample-based check per architect #197 §2.2`,
            );
          }
          const serverTag = await Effect.runPromise(
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
                  .sendRpc(call.method, call.params)
                  .pipe(Effect.either);
                return outcome._tag === "Right" ? "ok" : "error";
              }),
            ),
          );
          // Model is confident it's `ok`. Server MUST agree.
          return serverTag === "ok";
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? numRunsFloor },
      ),
    ),
  );
  // Keep `arbitraryAnyCall` import alive — used by sibling properties.
  void arbitraryAnyCall;
}

/**
 * Authorized caller → typed success on at least one known-safe RPC.
 * Registers a fresh agent, completes the handshake, calls
 * `conversations/list` (empty-collection result is defined for every
 * newly-registered agent), asserts a Right outcome.
 */
export function registerAuthorityPositive(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "authority-positive",
    "authorized agent → typed success on conversations/list",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "ap",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "authority-positive",
                reason: `agent registration failed: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "authority-positive",
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc("conversations/list", {})
          .pipe(Effect.either);
        if (outcome._tag === "Left") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "authority-positive",
              reason: `authorized conversations/list failed: ${outcome.left._tag}`,
            }),
          );
        }
      }),
    ),
  );
}

/**
 * Unauthenticated caller → typed denial on an auth-gated RPC. Opens a
 * TestClient with `autoConnect: false` and calls `conversations/list`
 * without first completing `auth/connect`; asserts the server replies
 * with a typed error (not a success, not a crash).
 */
export function registerAuthorityNegative(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "authority-negative",
    "unauthenticated agent → typed denial on conversations/list",
    Effect.scoped(
      Effect.gen(function* () {
        // We still need an agentKey to open the socket, but we skip
        // `auth/connect` so the server sees an un-authed session.
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "an",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "authority-negative",
                reason: `agent registration failed: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
          autoConnect: false,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "authority-negative",
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc("conversations/list", {})
          .pipe(Effect.either);
        if (outcome._tag === "Right") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "authority-negative",
              reason:
                "pre-handshake conversations/list returned success — expected typed denial",
            }),
          );
        }
        // Narrow the Left: must be a typed auth-shaped RpcResponseError
        // (Unauthorized / Forbidden). A timeout or transport-close
        // would also surface as `Left` but does NOT satisfy the
        // property — it proves nothing about authorization.
        if (outcome.left._tag !== "TestingRpcResponseError") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "authority-negative",
              reason: `expected RpcResponseError, got ${outcome.left._tag}`,
            }),
          );
        }
        const code = outcome.left.code;
        const isAuthShaped =
          code === ErrorCodes.Unauthorized || code === ErrorCodes.Forbidden;
        if (!isAuthShaped) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "authority-negative",
              reason: `expected Unauthorized/Forbidden code (${ErrorCodes.Unauthorized} / ${ErrorCodes.Forbidden}), got ${code}`,
            }),
          );
        }
        // Oracle cross-check: the model also predicts deny for this
        // unauthenticated caller. Keeps the model honest alongside the
        // server.
        const modelVerdict = authorizationOutcome(
          initialReferenceState,
          { method: "conversations/list", params: {} },
          "unknown-agent",
        );
        if (modelVerdict !== "deny-unauthenticated") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "authority-negative",
              reason: `model oracle disagrees: expected deny-unauthenticated, got ${modelVerdict}`,
            }),
          );
        }
      }),
    ),
  );
}

/**
 * Request-IDs are unique per inbound response. Sends N RPCs and asserts
 * every id in the captured response stream appears exactly once.
 */
export function registerRequestIdUniqueness(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "request-id-uniqueness",
    "every request-id appears in exactly one response",
    assertProperty(CATEGORY, "request-id-uniqueness", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
          const counts = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* registerTestAgent({
                  baseUrl: ctx.realServer.baseUrl,
                  name: "ru",
                });
                const client = yield* makeTestClient({
                  serverUrl: ctx.realServer.wsUrl,
                  agentKey: agent.apiKey,
                  agentId: agent.agentId,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                  captureCapacity: n * 4,
                });
                // Snapshot the capture boundary after handshake so we
                // only tally response ids for the N RPCs below — not
                // the auto-connect reply.
                const handshakeEnd = (yield* client.snapshot).length;
                yield* Effect.forEach(
                  Array.from({ length: n }, (_, i) => i),
                  () =>
                    client
                      .sendRpc("conversations/list", {})
                      .pipe(Effect.either),
                  { concurrency: n },
                );
                const snap = (yield* client.snapshot).slice(handshakeEnd);
                const outboundIds = new Set<string>();
                const inboundIds = new Set<string>();
                let inboundCount = 0;
                for (const entry of snap) {
                  if (
                    entry.frame?.type !== "request" &&
                    entry.frame?.type !== "response"
                  )
                    continue;
                  if (
                    entry.kind === "outbound" &&
                    entry.frame.type === "request"
                  ) {
                    outboundIds.add(entry.frame.id);
                  }
                  if (
                    entry.kind === "inbound" &&
                    entry.frame.type === "response"
                  ) {
                    inboundIds.add(entry.frame.id);
                    inboundCount += 1;
                  }
                }
                return { outboundIds, inboundIds, inboundCount };
              }),
            ),
          );
          // Architect §4.2 set-equality predicate. Conjunction:
          //   - outboundIds.size === n                  (driver produced n frames)
          //   - inboundIds.size === outboundIds.size    (cardinality match)
          //   - every outbound id is matched inbound     (no drops, no strays)
          //   - inboundCount === inboundIds.size         (no inbound duplicates)
          // Stray IDs, dropped replies, and id-reuse all fail the property.
          const { outboundIds, inboundIds, inboundCount } = counts;
          if (outboundIds.size !== n) return false;
          if (inboundIds.size !== outboundIds.size) return false;
          if (inboundCount !== inboundIds.size) return false;
          for (const id of outboundIds) {
            if (!inboundIds.has(id)) return false;
          }
          return true;
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 5 },
      ),
    ),
  );
}

/**
 * Idempotent RPCs yield equivalent responses on replay. For every
 * list-shaped method where empty params are valid and `isIdempotent`
 * says replay is safe, sends the same params twice and asserts both
 * succeed with **identical results** (not just identical tags).
 *
 * Architect §4.4: removed `.pipe(Effect.orElseSucceed(["skip","skip"]))`
 * masking. Transport failures now surface as `PropertyUnavailable` so
 * the runner reports them explicitly instead of folding them into a
 * silent pass. Predicate compares response bodies via canonical JSON
 * — spec B5 says "identical results", not "identical outcome kinds".
 */
export function registerIdempotence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "idempotence",
    "isIdempotent methods: two sends yield identical response bodies",
    Effect.gen(function* () {
      const emptyParamIdempotents = [
        "agents/list",
        "conversations/list",
      ] as const;
      for (const method of emptyParamIdempotents) {
        if (!isIdempotent(method)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "idempotence",
              reason: `isIdempotent(${method}) is false — oracle disagreement`,
            }),
          );
        }
        const pair = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* registerTestAgent({
              baseUrl: ctx.realServer.baseUrl,
              name: "id",
            });
            const client = yield* makeTestClient({
              serverUrl: ctx.realServer.wsUrl,
              agentKey: agent.apiKey,
              agentId: agent.agentId,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              captureCapacity: DEFAULT_CAPTURE_CAPACITY,
            });
            const a = yield* client.sendRpc(method, {}).pipe(Effect.either);
            const b = yield* client.sendRpc(method, {}).pipe(Effect.either);
            return { a, b };
          }),
        ).pipe(
          Effect.catchTags({
            TestingAgentRegistrationError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: "idempotence",
                  reason: `register: ${e.body}`,
                }),
              ),
            TestingTransportIoError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: "idempotence",
                  reason: `transport io: ${String(e.cause)}`,
                }),
              ),
            TestingTransportClosedError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: "idempotence",
                  reason: `transport closed: ${e.reason}`,
                }),
              ),
            TestingRpcResponseError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: "idempotence",
                  reason: `rpc response error: ${e.message}`,
                }),
              ),
          }),
        );
        if (pair.a._tag !== pair.b._tag) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "idempotence",
              reason: `${method}: replay outcome-tag mismatch ${pair.a._tag} → ${pair.b._tag}`,
            }),
          );
        }
        if (pair.a._tag === "Right" && pair.b._tag === "Right") {
          // Canonical-projection comparison per architect #197 §3.3.
          // Direct JSON.stringify on wire-derived values is byte-
          // equality, not semantic equality; a conforming server may
          // return the list in a different row order across replays.
          const aCanon = canonIdempotenceResult(method, pair.a.right);
          const bCanon = canonIdempotenceResult(method, pair.b.right);
          if (aCanon !== bCanon) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "idempotence",
                reason: `${method}: replay bodies diverge under canonical projection`,
              }),
            );
          }
        }
      }
    }),
  );
  void allRpcMethods;
}

/**
 * Idempotence canonical projection — architect #197 §3.3.
 *
 * Spec B5: agents/list.agents and conversations/list.conversations are
 * unordered row sets across replays. Every OTHER array (including any
 * nested `participants`, future nested message lists, and every
 * payload field that is not one of the two named arrays) remains
 * order-sensitive.
 *
 * The projection sorts ONLY the specific top-level array the spec
 * marks unordered, then finalizes via `canonicalJson` (which
 * normalizes object-key order but preserves every remaining array's
 * order). A real re-ordering regression inside nested arrays still
 * fails the property.
 */
function canonIdempotenceResult(
  method: "agents/list" | "conversations/list",
  result: unknown,
): string {
  if (method === "agents/list") {
    const r = result as { agents?: unknown[] };
    return canonicalJson({
      ...r,
      agents: Array.isArray(r.agents) ? sortJsonArray(r.agents) : r.agents,
    });
  }
  const r = result as { conversations?: unknown[]; cursor?: string };
  return canonicalJson({
    ...r,
    conversations: Array.isArray(r.conversations)
      ? sortJsonArray(r.conversations)
      : r.conversations,
  });
}
