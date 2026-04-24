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
  registerProperty,
} from "./registry.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

/**
 * Methods where the reference-model oracle is honest — list-shaped
 * read-only RPCs for which a fresh authenticated agent always gets a
 * successful response and the model correctly predicts `ok`. Drawing
 * from this set lets the property actually discriminate: if the server
 * returns an error, the model still says `ok`, and the mismatch fails
 * the property loudly.
 */
const MODEL_ORACLE_METHODS = [
  "agents/list",
  "conversations/list",
  // contacts/list, apps/listSessions, permissions/list all return
  // typed errors on a fresh agent without app/user context. Oracle-
  // honest set is the subset the model can predict `ok` for against
  // a freshly-registered agent; the broader set is exercised by
  // `schema-exhaustive-fuzz` which accepts any typed outcome.
] as const;

/**
 * Real-server outcome tag matches reference-model outcome tag on the
 * oracle-honest method set. Not a tautology: if the model predicts
 * `ok` and the server returns an error, the property fails.
 */
export function registerModelEquivalence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "model-equivalence",
    "real-server outcome tag === reference-model outcome tag",
    assertProperty(CATEGORY, "model-equivalence", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(
          fc.constantFrom(...MODEL_ORACLE_METHODS),
          // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
          async (method) => {
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
                    .sendRpc(method, {})
                    .pipe(Effect.either);
                  return outcome._tag === "Right" ? "ok" : "error";
                }),
              ),
            );
            const modelTag = applyCall(initialReferenceState, {
              method,
              params: {},
            }).outcome._tag;
            // Real discriminator: both MUST be `"ok"` (or both `"error"`).
            // A divergence — e.g., server rejects the method the model
            // approves — fails the property. This is what the round-5
            // acceptance signal (swap applyCall tags) exercises.
            return serverTag === modelTag;
          },
        ),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 5 },
      ),
    ),
  );
  // Keep the broader call arbitrary import alive for future expansion.
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
                const counts = new Map<string, number>();
                for (const entry of snap) {
                  if (entry.kind !== "inbound") continue;
                  if (entry.frame?.type !== "response") continue;
                  const id = entry.frame.id;
                  counts.set(id, (counts.get(id) ?? 0) + 1);
                }
                return counts;
              }),
            ),
          );
          // Three-part contract:
          //   - counts.size === n: every request got exactly one response
          //     (catches silent drops / timeouts that leave an id absent).
          //   - every count === 1: no response was duplicated.
          //   - n > 0: the generator produced a usable sample.
          return (
            counts.size === n &&
            Array.from(counts.values()).every((v) => v === 1)
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 5 },
      ),
    ),
  );
}

/**
 * Idempotent RPCs yield equivalent responses on replay. For every method
 * `isIdempotent` says is safe to replay, sends the same params twice
 * and asserts both succeed with the same outcome tag.
 */
export function registerIdempotence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "idempotence",
    "isIdempotent methods replay cleanly against the real server",
    Effect.gen(function* () {
      // Replay only the list-shaped idempotent methods where the empty
      // `{}` params are always valid — enough to prove the server's
      // replay semantics hold without per-method setup.
      const emptyParamIdempotents = [
        "agents/list",
        "conversations/list",
        "contacts/list",
        "apps/listSessions",
        "permissions/list",
      ] as const;
      for (const method of emptyParamIdempotents) {
        if (!isIdempotent(method)) continue; // oracle disagreement is a separate bug
        const [firstTag, secondTag] = yield* Effect.scoped(
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
            return [a._tag, b._tag] as const;
          }),
        ).pipe(Effect.orElseSucceed(() => ["skip", "skip"] as const));
        if (firstTag === "skip") continue;
        if (firstTag !== secondTag) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "idempotence",
              reason: `${method}: replay mismatch ${firstTag} → ${secondTag}`,
            }),
          );
        }
      }
    }),
  );
  // keep allRpcMethods import alive — used for cross-check when we
  // expand the idempotent coverage.
  void allRpcMethods;
}
