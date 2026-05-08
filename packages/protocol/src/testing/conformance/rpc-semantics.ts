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
import { Effect, Either } from "effect";
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
import {
  ForbiddenError,
  UnauthorizedError,
} from "../../transport/wire-errors.js";
import { AgentsList } from "../../identity/methods.js";
import { agentId } from "../branded-ids.js";
import { DispatchAuthorize } from "../../app/methods.js";
import { ConversationsList } from "../../task/methods.js";
import { canonicalJson, sortJsonArray } from "../canonicalize.js";
import { RpcResponseError } from "../errors.js";
import { makeTestClient } from "../test-client.js";
import { isRequestFrame, isResponseFrame } from "../codec.js";
import { registerTestAgent } from "../agent-registration.js";
import { type JsonRpcId } from "../../transport/wire.js";
import { allRpcMethods } from "../arbitraries/rpc.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "./registry.js";
import { eitherTag, leftOrNull } from "./_helpers.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const MODEL_EQUIVALENCE_PROPERTY = "model-equivalence";
const AUTHORITY_POSITIVE_PROPERTY = "authority-positive";
const AUTHORITY_NEGATIVE_PROPERTY = "authority-negative";
const REQUEST_ID_UNIQUENESS_PROPERTY = "request-id-uniqueness";
const CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY =
  "caller-controlled-app-callback-timeout";
const IDEMPOTENCE_PROPERTY = "idempotence";
const MODEL_NUM_RUNS_FLOOR = 10;
const MODEL_RUNS_PER_CONFIDENT_METHOD = 2;
const RESPONSE_CAPTURE_CAPACITY_PER_REQUEST = 4;
const REQUEST_ID_UNIQUENESS_NUM_RUNS = 5;
const TIMEOUT_LOWER_MARGIN_MS = 20;
const TIMEOUT_UPPER_MULTIPLIER = 4;

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
  const numRunsFloor = Math.max(
    MODEL_NUM_RUNS_FLOOR,
    MODEL_RUNS_PER_CONFIDENT_METHOD * K,
  );
  registerProperty(
    ctx,
    CATEGORY,
    MODEL_EQUIVALENCE_PROPERTY,
    `when model predicts ok, server MUST return ok (K=${K} confident methods)`,
    assertProperty(CATEGORY, MODEL_EQUIVALENCE_PROPERTY, () =>
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
                  name: MODEL_EQUIVALENCE_PROPERTY,
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
    AUTHORITY_POSITIVE_PROPERTY,
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
                name: AUTHORITY_POSITIVE_PROPERTY,
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
                name: AUTHORITY_POSITIVE_PROPERTY,
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc(ConversationsList, {})
          .pipe(Effect.either);
        const failure = leftOrNull(outcome);
        if (failure !== null) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: AUTHORITY_POSITIVE_PROPERTY,
              reason: `authorized conversations/list failed: ${failure._tag}`,
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
 * without first completing `network/connect`; asserts the server replies
 * with a typed error (not a success, not a crash).
 */
export function registerAuthorityNegative(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    AUTHORITY_NEGATIVE_PROPERTY,
    "unauthenticated agent → typed denial on conversations/list",
    Effect.scoped(
      Effect.gen(function* () {
        // We still need an agentKey to open the socket, but we skip
        // `network/connect` so the server sees an un-authed session.
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "an",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: AUTHORITY_NEGATIVE_PROPERTY,
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
                name: AUTHORITY_NEGATIVE_PROPERTY,
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc(ConversationsList, {})
          .pipe(Effect.either);
        const error = yield* Either.match(outcome, {
          onLeft: (failure) => Effect.succeed(failure),
          onRight: () =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: AUTHORITY_NEGATIVE_PROPERTY,
                reason:
                  "pre-handshake conversations/list returned success — expected typed denial",
              }),
            ),
        });
        // Narrow the Left: must be a typed auth-shaped RpcResponseError
        // (Unauthorized / Forbidden). A timeout or transport-close
        // would also surface as `Left` but does NOT satisfy the
        // property — it proves nothing about authorization.
        if (!(error instanceof RpcResponseError)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: AUTHORITY_NEGATIVE_PROPERTY,
              reason: `expected RpcResponseError, got ${error._tag}`,
            }),
          );
        }
        const code = error.code;
        const isAuthShaped =
          code === UnauthorizedError.code || code === ForbiddenError.code;
        if (!isAuthShaped) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: AUTHORITY_NEGATIVE_PROPERTY,
              reason: `expected Unauthorized/Forbidden code (${UnauthorizedError.code} / ${ForbiddenError.code}), got ${code}`,
            }),
          );
        }
        // Oracle cross-check: the model also predicts deny for this
        // unauthenticated caller. Keeps the model honest alongside the
        // server.
        const modelVerdict = authorizationOutcome(
          initialReferenceState,
          {
            definition: ConversationsList,
            method: ConversationsList.name,
            params: {},
          },
          agentId("00000000-0000-4000-8000-000000000000"),
        );
        if (modelVerdict !== "deny-unauthenticated") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: AUTHORITY_NEGATIVE_PROPERTY,
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
    REQUEST_ID_UNIQUENESS_PROPERTY,
    "every request-id appears in exactly one response",
    assertProperty(CATEGORY, REQUEST_ID_UNIQUENESS_PROPERTY, () =>
      fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), (n) =>
          Effect.runPromise(
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
                  captureCapacity: n * RESPONSE_CAPTURE_CAPACITY_PER_REQUEST,
                });
                // Snapshot the capture boundary after handshake so we
                // only tally response ids for the N RPCs below — not
                // the auto-connect reply.
                const handshakeEnd = (yield* client.snapshot).length;
                yield* Effect.forEach(
                  Array.from({ length: n }, (_, i) => i),
                  () =>
                    client.sendRpc(ConversationsList, {}).pipe(Effect.either),
                  { concurrency: n },
                );
                const snap = (yield* client.snapshot).slice(handshakeEnd);
                const outboundIds = new Set<JsonRpcId>();
                const inboundIds = new Set<JsonRpcId>();
                let inboundCount = 0;
                for (const entry of snap) {
                  if (entry.frame === null) continue;
                  if (
                    entry.kind === "outbound" &&
                    isRequestFrame(entry.frame)
                  ) {
                    outboundIds.add(entry.frame.id);
                  }
                  if (
                    entry.kind === "inbound" &&
                    isResponseFrame(entry.frame) &&
                    typeof entry.frame.id === "string"
                  ) {
                    inboundIds.add(entry.frame.id);
                    inboundCount += 1;
                  }
                }
                return { outboundIds, inboundIds, inboundCount };
              }),
            ).pipe(
              Effect.map((counts) => {
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
            ),
          ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? REQUEST_ID_UNIQUENESS_NUM_RUNS,
        },
      ),
    ),
  );
}

/**
 * Spurious appCallback responses do not crash or poison the server. Architect
 * plan §3.3 + §1.7: the server's `appCallbackPending` map keys on the request id
 * it allocated; an inbound appCallback response with no matching pending entry
 * is dropped, the connection stays responsive.
 *
 * Status: tombstoned as `PropertyDeferred`. TestClient's public surface
 * only sends normal client-originated requests; injecting an unsolicited
 * server-originated response on the wire requires either a raw-write primitive
 * on TestClient or a server-side fault-injection seam. The wire-level
 * injection is exercised in B.9 server integration tests where the connection
 * ref is reachable. Tombstoning here keeps the conformance contract visible
 * and avoids reporting false coverage (codex review #327, finding 1).
 */
export function registerSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
): void {
  void ctx;
  registerProperty(
    ctx,
    CATEGORY,
    "spurious-app-callback-frame-handling",
    "stray appCallback response with no matching pending ⇒ server drops & stays alive",
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name: "spurious-app-callback-frame-handling",
        followUp:
          "wire-level raw-frame injection requires TestClient extension; B.9 (#318) covers via server-side fault injection",
      }),
    ),
  );
}

/**
 * Caller-controlled appCallback timeout — `awaitServerRequest(method, undef,
 * timeoutMs)` returns a timeout error when no appCallback request arrives in the
 * window. Architect plan §3.4: timeout policy lives in the caller
 * (`Effect.timeout(manifestHookTimeout)` at the AppHost call site), NOT
 * in the schema. This property anchors the caller-side behaviour the
 * AppHost relies on.
 *
 * Pure-TestClient property — fast, deterministic, no real-server hook
 * machinery required. Asserts the timeout is OBSERVABLE (a typed Error)
 * and FIRES IN THE WINDOW the caller passed (within 2x to absorb CI
 * scheduling noise).
 */
export function registerCallerControlledAppCallbackTimeout(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
    "awaitServerRequest(_, _, timeoutMs) fires within the caller's window",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "ct",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
                reason: `register agent: ${e.body}`,
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
                name: CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
                reason: `client acquire: ${String(e)}`,
              }),
          ),
        );
        // 250ms (rather than the architect plan's example 100ms) hardens
        // against CI scheduler tails; loaded shared runners can absorb
        // 200–500ms on a 100ms timer, while a 250ms timer with the same
        // 4× upper bound stays well clear of the flake band.
        const timeoutMs = 250;
        const lowerBoundMs = timeoutMs - TIMEOUT_LOWER_MARGIN_MS;
        const upperBoundMs = timeoutMs * TIMEOUT_UPPER_MULTIPLIER;
        const before = Date.now();
        const outcome = yield* client
          .awaitServerRequest(DispatchAuthorize, undefined, timeoutMs)
          .pipe(Effect.either);
        const elapsed = Date.now() - before;
        const timeoutError = yield* Either.match(outcome, {
          onLeft: (error) => Effect.succeed(error),
          onRight: () =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
                reason: `expected Left (timeout); got Right (appCallback request fired)`,
              }),
            ),
        });
        if (!/Timeout/i.test(timeoutError.message)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
              reason: `expected timeout error; got ${timeoutError.message}`,
            }),
          );
        }
        // Window is the caller's. Floor rejects "timed out before the
        // caller's deadline" — would mean a schema-level cap is shadowing
        // the manifest timeout. Ceiling rejects "still timing out long
        // after the caller's deadline" — would mean the manifest timeout
        // does not actually drive the firing.
        if (elapsed < lowerBoundMs || elapsed > upperBoundMs) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: CALLER_CONTROLLED_APP_CALLBACK_TIMEOUT_PROPERTY,
              reason: `timeout fired at ${elapsed}ms; caller asked for ${timeoutMs}ms (window: ${lowerBoundMs}–${upperBoundMs}ms)`,
            }),
          );
        }
      }),
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
    IDEMPOTENCE_PROPERTY,
    "isIdempotent methods: two sends yield identical response bodies",
    Effect.gen(function* () {
      const emptyParamIdempotents = [AgentsList, ConversationsList] as const;
      for (const definition of emptyParamIdempotents) {
        const method = definition.name;
        if (!isIdempotent(method)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: IDEMPOTENCE_PROPERTY,
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
            const a = yield* client.sendRpc(definition, {}).pipe(Effect.either);
            const b = yield* client.sendRpc(definition, {}).pipe(Effect.either);
            return { a, b };
          }),
        ).pipe(
          Effect.catchTags({
            TestingAgentRegistrationError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: IDEMPOTENCE_PROPERTY,
                  reason: `register: ${e.body}`,
                }),
              ),
            TestingTransportIoError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: IDEMPOTENCE_PROPERTY,
                  reason: `transport io: ${String(e.cause)}`,
                }),
              ),
            TestingTransportClosedError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: IDEMPOTENCE_PROPERTY,
                  reason: `transport closed: ${e.reason}`,
                }),
              ),
            TestingRpcResponseError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: IDEMPOTENCE_PROPERTY,
                  reason: `rpc response error: ${e.message}`,
                }),
              ),
          }),
        );
        const aTag = eitherTag(pair.a);
        const bTag = eitherTag(pair.b);
        if (aTag !== bTag) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: IDEMPOTENCE_PROPERTY,
              reason: `${method}: replay outcome-tag mismatch ${aTag} → ${bTag}`,
            }),
          );
        }
        const successPair = Either.match(pair.a, {
          onLeft: () => null,
          onRight: (a) =>
            Either.match(pair.b, {
              onLeft: () => null,
              onRight: (b) => ({ a, b }),
            }),
        });
        if (successPair !== null) {
          // Canonical-projection comparison per architect #197 §3.3.
          // Direct JSON.stringify on wire-derived values is byte-
          // equality, not semantic equality; a conforming server may
          // return the list in a different row order across replays.
          const aCanon = canonIdempotenceResult(method, successPair.a);
          const bCanon = canonIdempotenceResult(method, successPair.b);
          if (aCanon !== bCanon) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: IDEMPOTENCE_PROPERTY,
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
  method: typeof AgentsList.name | typeof ConversationsList.name,
  result: unknown,
): string {
  if (method === AgentsList.name) {
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
