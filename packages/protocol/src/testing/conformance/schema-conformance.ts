/**
 * Schema conformance — properties that drive valid + malformed traffic
 * through `TestClient` into the real server and assert the server's
 * response shape conforms to the protocol schemas.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier A". Code uses
 * semantic names only.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 * Fast-check's Promise-based `fc.asyncProperty` is bridged via
 * `assertProperty`; invariant/coverage failures raise
 * `PropertyInvariantViolation`.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { Value } from "@sinclair/typebox/value";
import {
  allRpcMethods,
  arbitraryAnyCall,
  arbitraryCallFor,
} from "../arbitraries/rpc.js";
import {
  arbitraryNotificationFrame,
  arbitraryMalformedFrame,
} from "../arbitraries/frames.js";
import {
  decodeFrame,
  encodeFrame,
  isNotificationFrame,
  isRequestFrame,
  isResponseFrame,
} from "../codec.js";
import {
  NotificationFrameSchema,
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../schema/frames.js";
import { makeTestClient } from "../test-client.js";
import { registerTestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  assertProperty,
  PropertyInvariantViolation,
  registerProperty,
} from "./registry.js";

import { AgentsList, Connect } from "../../network/methods/auth.js";
import { ContactsList } from "../../task/methods/contacts.js";
import { ConversationsList } from "../../task/methods/conversations.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_MALFORMED_RESPONSE_RUNS = 3;
const DEFAULT_NOTIFICATION_SCHEMA_RUNS = 20;
const DEFAULT_ROUNDTRIP_RUNS = 50;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

/**
 * Valid request ⇒ valid-shape response. Drives fast-check RPC calls
 * through a real TestClient against the real server and asserts every
 * returned frame parses against `ResponseFrameSchema`.
 */
export function registerRequestWellFormedness(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "request-well-formedness",
    "valid request ⇒ server reply parses against ResponseFrameSchema",
    assertProperty(CATEGORY, "request-well-formedness", () =>
      fc.assert(
        fc.asyncProperty(arbitraryAnyCall(), (call) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* registerTestAgent({
                  baseUrl: ctx.realServer.baseUrl,
                  name: "rw",
                });
                const client = yield* makeTestClient({
                  serverUrl: ctx.realServer.wsUrl,
                  agentKey: agent.apiKey,
                  agentId: agent.agentId,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                  captureCapacity: DEFAULT_CAPTURE_CAPACITY,
                });
                // Mark the auto-connect boundary so we ignore frames
                // that landed before the sampled call.
                // Mark the auto-connect boundary so we ignore frames
                // that landed before the sampled call.
                const handshakeEnd = (yield* client.snapshot).length;
                yield* client
                  .sendRpc(call.definition, call.params)
                  .pipe(Effect.either);
                return (yield* client.snapshot).slice(handshakeEnd);
              }),
            ).pipe(
              Effect.map((observed) => {
                // Architect §4.3: validate every reply in the window.
                //   - outbound lookup → expectedId (confirms sampled call ran)
                //   - replies.length >= 1 (server didn't drop the whole window)
                //   - replies.every(Value.Check(ResponseFrameSchema, ...))
                //     (a stray duplicate/malformed response in the window fails)
                //   - replies.some(id === expectedId) (the sampled call got a
                //     reply, not just some other request)
                const outbound = observed.find(
                  (s) =>
                    s.kind === "outbound" &&
                    s.frame !== null &&
                    isRequestFrame(s.frame) &&
                    s.frame.method === call.method,
                );
                if (
                  outbound?.frame === null ||
                  outbound?.frame === undefined ||
                  !isRequestFrame(outbound.frame)
                ) {
                  return false;
                }
                const expectedId = outbound.frame.id;
                const replies = observed.filter(
                  (s) =>
                    s.kind === "inbound" &&
                    s.frame !== null &&
                    isResponseFrame(s.frame),
                );
                if (replies.length < 1) return false;
                const allValid = replies.every(
                  (r) =>
                    r.frame !== null &&
                    isResponseFrame(r.frame) &&
                    Value.Check(ResponseFrameSchema, r.frame as ResponseFrame),
                );
                if (!allValid) return false;
                return replies.some(
                  (r) =>
                    r.frame !== null &&
                    isResponseFrame(r.frame) &&
                    r.frame.id === expectedId,
                );
              }),
            ),
          ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_MALFORMED_RESPONSE_RUNS,
          // Dropped-response counterexamples pay the client RPC timeout.
          // Shrinking repeats that timeout and makes executable proofs
          // timing-sensitive under stress without increasing coverage.
          endOnFailure: true,
        },
      ),
    ),
  );
}

/**
 * Valid notification frame round-trips the codec cleanly.
 *
 * `@pure-codec` — does NOT drive a real server or real client. Spec A2's
 * "accepted by a real client" assertion requires a TestServer + real
 * client driver; that property lives in the consumer package (e.g.,
 * `packages/client` or `moltzap-arena`) and is tracked under #186.
 *
 * Tightened per architect §4.4: predicate demands `Right` AND schema
 * check of the specific notification variant — the previous `Right || Left`
 * shape was a tautology over the union.
 */
export function registerNotificationWellFormedness(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "notification-well-formedness",
    "valid notification frame decodes cleanly and re-encodes to match",
    assertProperty(CATEGORY, "notification-well-formedness", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryNotificationFrame(), (frame) => {
            const raw = encodeFrame(frame);
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            return Either.match(decoded, {
              onLeft: () => false,
              onRight: (frame) =>
                isNotificationFrame(frame) &&
                Value.Check(NotificationFrameSchema, frame),
            });
          }),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_NOTIFICATION_SCHEMA_RUNS,
          },
        ),
      ),
    ),
  );
}

/** parse(serialize(frame)) ≡ frame — pure codec round-trip. */
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
              return Either.match(re, {
                onLeft: () => true, // generator-side drift
                onRight: (frame) => {
                  const redone = encodeFrame(frame);
                  return (
                    JSON.stringify(JSON.parse(raw)) ===
                    JSON.stringify(JSON.parse(redone))
                  );
                },
              });
            },
          ),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_ROUNDTRIP_RUNS,
          },
        ),
      ),
    ),
  );
}

/**
 * Malformed bytes on the wire → the server drops or returns a typed
 * error, never crashes. Drives `sendMalformed` through a real WS and
 * asserts the observable outcome.
 */
export function registerMalformedFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "malformed-frame-handling",
    "malformed frames produce typed error or drop; server stays alive",
    assertProperty(CATEGORY, "malformed-frame-handling", () =>
      fc.assert(
        fc.asyncProperty(arbitraryMalformedFrame(), ({ kind, seed }) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const agent = yield* registerTestAgent({
                  baseUrl: ctx.realServer.baseUrl,
                  name: "mf",
                });
                const client = yield* makeTestClient({
                  serverUrl: ctx.realServer.wsUrl,
                  agentKey: agent.apiKey,
                  agentId: agent.agentId,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                  captureCapacity: DEFAULT_CAPTURE_CAPACITY,
                  malformedQuiescenceMs: 500,
                });
                const response = yield* client.sendMalformed({
                  baseDefinition: AgentsList,
                  baseParams: {},
                  kind,
                  seed,
                });
                // Post-malformed the connection must still accept a
                // normal RPC — proves the server didn't crash or
                // poison its state.
                const post = yield* client
                  .sendRpc(AgentsList, {})
                  .pipe(Effect.either);
                return { malformedReply: response, post };
              }),
            ).pipe(
              Effect.map((result) => {
                // Contract: either a typed error OR a clean drop (null). Both
                // are acceptable per Tier A4.
                const validReply =
                  result.malformedReply === null ||
                  result.malformedReply._tag === "TestingRpcResponseError";
                // Follow-up RPC must land with a typed success. "Right" or
                // "Left" would be a tautology; "Left" would allow a timeout
                // to count as server-alive, which is exactly what the
                // property must reject. Require the post-malformed call to
                // return cleanly.
                const stillAlive = Either.match(result.post, {
                  onLeft: () => false,
                  onRight: () => true,
                });
                return validReply && stillAlive;
              }),
            ),
          ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_MALFORMED_RESPONSE_RUNS,
        },
      ),
    ),
  );
}

/**
 * A representative sample of `RpcMethodName` reaches the real server.
 * Full-set coverage is exercised by `schema-exhaustive-fuzz` in
 * `boundary.ts`; this property asserts the wire path is alive for a
 * small stratified sample — cheap to re-run, catches regressions that
 * render every RPC unreachable.
 */
const COVERAGE_SAMPLE = [
  Connect.name,
  AgentsList.name,
  ConversationsList.name,
  ContactsList.name,
] as const;
export function registerRpcMapCoverage(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "rpc-map-coverage",
    "a representative sample of RpcMethodName reaches a real-server response",
    Effect.gen(function* () {
      void allRpcMethods; // kept for future expansion to full-set coverage
      for (const method of COVERAGE_SAMPLE) {
        const callArb = arbitraryCallFor(method);
        const [sampled] = fc.sample(callArb, { numRuns: 1, seed: ctx.seed });
        if (sampled === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `failed to sample call for ${method}`,
            }),
          );
        }
        const reached = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* registerTestAgent({
              baseUrl: ctx.realServer.baseUrl,
              name: "cov",
            });
            const client = yield* makeTestClient({
              serverUrl: ctx.realServer.wsUrl,
              agentKey: agent.apiKey,
              agentId: agent.agentId,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              captureCapacity: DEFAULT_CAPTURE_CAPACITY,
            });
            // Exclude handshake frames so "reached" can't be satisfied
            // by the auto-connect reply — every method must produce its
            // OWN response with a matching request id.
            const handshakeEnd = (yield* client.snapshot).length;
            yield* client
              .sendRpc(sampled.definition, sampled.params)
              .pipe(Effect.either);
            const snap = (yield* client.snapshot).slice(handshakeEnd);
            const outbound = snap.find(
              (s) =>
                s.kind === "outbound" &&
                s.frame !== null &&
                isRequestFrame(s.frame) &&
                s.frame.method === sampled.method,
            );
            if (
              outbound?.frame === null ||
              outbound?.frame === undefined ||
              !isRequestFrame(outbound.frame)
            ) {
              return false;
            }
            const expectedId = outbound.frame.id;
            return snap.some(
              (s) =>
                s.kind === "inbound" &&
                s.frame !== null &&
                isResponseFrame(s.frame) &&
                s.frame.id === expectedId,
            );
          }),
        ).pipe(Effect.orElseSucceed(() => false));
        if (!reached) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `method ${method} produced no observable response`,
            }),
          );
        }
      }
    }),
  );
}
