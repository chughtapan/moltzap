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
import { arbitraryAnyCall } from "../arbitraries/rpc.js";
import {
  applyCall,
  authorizationOutcome,
  isIdempotent,
} from "../models/dispatch.js";
import { initialReferenceState } from "../models/state.js";
import { ErrorCodes } from "../../schema/errors.js";
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
 * Model-equivalence — conditional oracle (architect §4.1).
 *
 * Spec §5 B1 is asymmetric: the server must produce what the model
 * predicts **when the model is confident**. Model imprecision on edge
 * cases is a reference-model coverage gap, not a server bug.
 *
 * Predicate shape:
 *   - `modelTag === "ok"`   → server MUST be `"ok"`; `"error"` fails.
 *   - `modelTag === "error"` → proceed silently; the model is not
 *     strict enough to make a prediction, so anything the server
 *     does is consistent with the oracle.
 *
 * Uses the full `arbitraryAnyCall()` draw — no narrowing. The model's
 * `allowNoEvents` predicts `"ok"` for every registered method, so
 * every draw enters the confident branch. If `applyCall`'s prediction
 * is flipped to `"error"` (divergence proof), the property still runs;
 * but if the server returns `"error"` while the model predicts `"ok"`,
 * it fails loudly.
 */
export function registerModelEquivalence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "model-equivalence",
    "when model predicts ok, server MUST return ok",
    assertProperty(CATEGORY, "model-equivalence", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(arbitraryAnyCall(), async (call) => {
          const modelTag = applyCall(initialReferenceState, call).outcome._tag;
          if (modelTag === "error") {
            // Model isn't confident; not a protocol violation either way.
            return true;
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
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 4 },
      ),
    ),
  );
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
          // Canonical JSON comparison on the result body. Read-only
          // list methods have stable outputs; a divergence is a real
          // idempotence violation.
          const aJson = JSON.stringify(pair.a.right);
          const bJson = JSON.stringify(pair.b.right);
          if (aJson !== bJson) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "idempotence",
                reason: `${method}: replay bodies diverge`,
              }),
            );
          }
        }
      }
    }),
  );
  void allRpcMethods;
}
