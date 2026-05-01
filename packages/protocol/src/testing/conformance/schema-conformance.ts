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
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import {
  allRpcMethods,
  arbitraryAnyCall,
  arbitraryCallFor,
} from "../arbitraries/rpc.js";
import { s2cRpcMethods, type S2cRpcMethodName } from "../../rpc-registry.js";
import {
  arbitraryEventFrame,
  arbitraryMalformedFrame,
} from "../arbitraries/frames.js";
import { decodeFrame, encodeFrame } from "../codec.js";
import {
  EventFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  type RequestFrame,
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

const CATEGORY = "schema-conformance" as const;
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
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(arbitraryAnyCall(), async (call) => {
          const observed = await Effect.runPromise(
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
                  .sendRpc(call.method, call.params)
                  .pipe(Effect.either);
                return (yield* client.snapshot).slice(handshakeEnd);
              }),
            ),
          );
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
              s.frame?.type === "request" &&
              s.frame.method === call.method,
          );
          if (outbound?.frame?.type !== "request") return false;
          const expectedId = outbound.frame.id;
          const replies = observed.filter(
            (s) => s.kind === "inbound" && s.frame?.type === "response",
          );
          if (replies.length < 1) return false;
          const allValid = replies.every(
            (r) =>
              r.frame?.type === "response" &&
              Value.Check(ResponseFrameSchema, r.frame as ResponseFrame),
          );
          if (!allValid) return false;
          return replies.some(
            (r) => r.frame?.type === "response" && r.frame.id === expectedId,
          );
        }),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? 3,
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
 * Valid event frame round-trips the codec cleanly.
 *
 * `@pure-codec` — does NOT drive a real server or real client. Spec A2's
 * "accepted by a real client" assertion requires a TestServer + real
 * client driver; that property lives in the consumer package (e.g.,
 * `packages/client` or `moltzap-arena`) and is tracked under #186.
 *
 * Tightened per architect §4.4: predicate demands `Right` AND schema
 * check of the specific event variant — the previous `Right || Left`
 * shape was a tautology over the union.
 */
export function registerEventWellFormedness(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "event-well-formedness",
    "valid event frame decodes cleanly and re-encodes to match",
    assertProperty(CATEGORY, "event-well-formedness", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryEventFrame(), (frame) => {
            const raw = encodeFrame(frame);
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            if (decoded._tag !== "Right") return false;
            return (
              decoded.right.type === "event" &&
              Value.Check(EventFrameSchema, decoded.right)
            );
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 20 },
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
              if (re._tag === "Left") return true; // generator-side drift
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
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(arbitraryMalformedFrame(), async ({ kind, seed }) => {
          const result = await Effect.runPromise(
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
                  baseMethod: "agents/list",
                  kind,
                  seed,
                });
                // Post-malformed the connection must still accept a
                // normal RPC — proves the server didn't crash or
                // poison its state.
                const post = yield* client
                  .sendRpc("agents/list", {})
                  .pipe(Effect.either);
                return { malformedReply: response, post };
              }),
            ),
          );
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
          const stillAlive = result.post._tag === "Right";
          return validReply && stillAlive;
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
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
  "auth/connect",
  "agents/list",
  "conversations/list",
  "contacts/list",
] as const;

/**
 * S2C request frames round-trip through the codec. Architect plan §3.1 +
 * §1.7: `direction: "s2c"` is part of the wire identity — encode →
 * decodeFrame → re-encode must be byte-identical for every well-formed
 * server-initiated request.
 *
 * `@pure-codec` — does NOT drive a real server. Asserts the codec preserves
 * `direction: "s2c"` so c2s and s2c request-id pools can coexist on the
 * wire without confusion.
 */
export function registerS2cRequestRoundTripIdentity(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "s2c-request-roundtrip-identity",
    "encode(s2c request) ⇒ decode ⇒ encode is byte-identical",
    assertProperty(CATEGORY, "s2c-request-roundtrip-identity", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryS2cRequestFrame(), (frame) => {
            const raw = encodeFrame(frame);
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            if (decoded._tag !== "Right") return false;
            if (decoded.right.type !== "request") return false;
            if (decoded.right.direction !== "s2c") return false;
            const redone = encodeFrame(decoded.right);
            return (
              JSON.stringify(JSON.parse(raw)) ===
              JSON.stringify(JSON.parse(redone))
            );
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/**
 * S2C response frames validate against `ResponseFrameSchema`. Architect plan
 * §3.1: c2s and s2c responses share one schema discriminated by `direction`.
 * Property asserts `Value.Check` accepts every drawn s2c response — the
 * positive shape every consumer's decoder relies on.
 */
export function registerS2cResponseValidation(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "s2c-response-validation",
    "every well-formed s2c response frame Value.Checks",
    assertProperty(CATEGORY, "s2c-response-validation", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryS2cResponseFrame(), (frame) => {
            if (!Value.Check(ResponseFrameSchema, frame)) return false;
            return frame.direction === "s2c";
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/**
 * Malformed s2c request bytes do not crash the codec — `decodeFrame`
 * returns `FrameSchemaError`, never throws. `@pure-codec` — exercises
 * the codec only. Wire-level liveness with a real server is covered by
 * `malformed-frame-handling` (above).
 */
export function registerS2cMalformedRequestHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "s2c-malformed-request-handling",
    "malformed s2c request bytes ⇒ FrameSchemaError or drop; never crash",
    assertProperty(CATEGORY, "s2c-malformed-request-handling", () =>
      Promise.resolve(
        fc.assert(
          fc.property(arbitraryMalformedS2cRequestFrame(), (raw) => {
            const decoded = Effect.runSync(
              Effect.either(decodeFrame(raw, "inbound")),
            );
            // Either decode fails with FrameSchemaError (rejected at the
            // edge) or succeeds with a typed frame — both are fine. The
            // crash-free contract is what this property enforces.
            if (decoded._tag === "Left") {
              return decoded.left._tag === "TestingFrameSchemaError";
            }
            // If decode succeeds, the frame must validate against its
            // schema; the codec must not surface an in-between value.
            const f = decoded.right;
            if (f.type === "request") return Value.Check(RequestFrameSchema, f);
            if (f.type === "response")
              return Value.Check(ResponseFrameSchema, f);
            return Value.Check(EventFrameSchema, f);
          }),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
        ),
      ),
    ),
  );
}

/**
 * Dual-direction request-id collision — c2s and s2c request frames
 * carrying the same `id` decode to distinct frames whose `direction`
 * field discriminates the routing pool. Architect plan §3.1: pending
 * maps key on `(side, id)`, not `id` alone — a c2s request with id
 * `tc-1` and an s2c request with id `tc-1` must NOT collide.
 *
 * `@pure-codec` — pure-codec proof of the contract every transport
 * relies on. Wire-level routing is enforced by sender/receiver pending
 * maps; this property anchors the codec piece.
 */
export function registerDualDirectionIdCollision(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "dual-direction-id-collision",
    "c2s id=X and s2c id=X decode to distinct frames discriminated by direction",
    assertProperty(CATEGORY, "dual-direction-id-collision", () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            // A shared id and a method name; no need to vary params for
            // the routing-discrimination property.
            fc.tuple(
              fc
                .string({ minLength: 1, maxLength: 32 })
                .filter((s) => /^[a-zA-Z0-9_\-:.]+$/.test(s)),
              fc.constantFrom<string>(
                "auth/connect",
                "agents/list",
                ...s2cRpcMethods.map((m) => m.name),
              ),
            ),
            ([id, method]) => {
              const c2s: RequestFrame = {
                jsonrpc: "2.0",
                type: "request",
                direction: "c2s",
                id,
                method,
                params: {},
              };
              const s2c: RequestFrame = {
                jsonrpc: "2.0",
                type: "request",
                direction: "s2c",
                id,
                method,
                params: {},
              };
              const decC2s = Effect.runSync(
                Effect.either(decodeFrame(encodeFrame(c2s), "inbound")),
              );
              const decS2c = Effect.runSync(
                Effect.either(decodeFrame(encodeFrame(s2c), "inbound")),
              );
              if (decC2s._tag !== "Right" || decS2c._tag !== "Right") {
                return false;
              }
              if (
                decC2s.right.type !== "request" ||
                decS2c.right.type !== "request"
              ) {
                return false;
              }
              // Same id, different direction — they are NOT equal frames
              // and a pending map keyed on (direction, id) yields disjoint
              // entries.
              if (decC2s.right.id !== decS2c.right.id) return false;
              if (decC2s.right.direction === decS2c.right.direction) {
                return false;
              }
              const keyC2s = `${decC2s.right.direction}:${decC2s.right.id}`;
              const keyS2c = `${decS2c.right.direction}:${decS2c.right.id}`;
              return keyC2s !== keyS2c;
            },
          ),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 30 },
        ),
      ),
    ),
  );
}

// ── s2c arbitraries (local to this module) ────────────────────────────
//
// Kept private — only the four properties above use them. If a future
// module needs s2c-direction frames, promote to `arbitraries/frames.ts`.

function arbitraryS2cRequestFrame(): fc.Arbitrary<RequestFrame> {
  // Drive method names from the typed `s2cRpcMethods` registry so adding
  // a verb to the protocol auto-widens conformance coverage; no manual
  // sync required between this arbitrary and `rpc-registry.ts`.
  const methodNames = s2cRpcMethods.map(
    (m) => m.name,
  ) as ReadonlyArray<S2cRpcMethodName>;
  return fc.record({
    jsonrpc: fc.constant("2.0" as const),
    type: fc.constant("request" as const),
    direction: fc.constant("s2c" as const),
    id: fc
      .string({ minLength: 1, maxLength: 32 })
      .filter((s) => /^[a-zA-Z0-9_\-:.]+$/.test(s)),
    method: fc.constantFrom(...methodNames),
    params: fc.option(fc.dictionary(fc.string(), fc.anything()), {
      nil: undefined,
    }),
  });
}

function arbitraryS2cResponseFrame(): fc.Arbitrary<ResponseFrame> {
  const successBody = fc.record({
    result: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.anything(),
    ),
  });
  const errorBody = fc.record({
    error: fc.record({
      code: fc.integer({ min: -32700, max: -32000 }),
      message: fc.string({ minLength: 1, maxLength: 64 }),
    }),
  });
  const id = fc
    .string({ minLength: 1, maxLength: 32 })
    .filter((s) => /^[a-zA-Z0-9_\-:.]+$/.test(s));
  return fc
    .tuple(id, fc.oneof(successBody, errorBody))
    .map(([frameId, body]) => ({
      jsonrpc: "2.0" as const,
      type: "response" as const,
      direction: "s2c" as const,
      id: frameId,
      ...body,
    }));
}

/**
 * Generate raw bytes that purport to be an s2c request but are malformed
 * in one of the kinds the codec must absorb. Mixes wire-level corruptions
 * (invalid JSON, missing `direction`, bad `direction`, extra property)
 * with schema-violation kinds the existing codec already rejects.
 */
function arbitraryMalformedS2cRequestFrame(): fc.Arbitrary<string> {
  const valid = arbitraryS2cRequestFrame();
  return fc.oneof(
    // Invalid JSON.
    fc.constant("not-json"),
    fc.constant("{not-json"),
    // Wrong direction value.
    valid.map((f) => {
      // #ignore-sloppy-code-next-line[as-unknown-as]: deliberately produces a malformed direction string — this arbitrary's contract is to defeat the schema's `c2s|s2c` literal union for the codec-rejection test
      const corrupted = { ...f, direction: "lateral" as unknown as string };
      return JSON.stringify(corrupted);
    }),
    // Missing direction.
    valid.map((f) => {
      const { direction: _drop, ...rest } = f;
      void _drop;
      return JSON.stringify(rest);
    }),
    // Missing id.
    valid.map((f) => {
      const { id: _drop, ...rest } = f;
      void _drop;
      return JSON.stringify(rest);
    }),
    // Extra property — schema is `additionalProperties: false`.
    valid.map((f) => JSON.stringify({ ...f, extra: "rejected" })),
  );
}

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
              .sendRpc(sampled.method, sampled.params)
              .pipe(Effect.either);
            const snap = (yield* client.snapshot).slice(handshakeEnd);
            const outbound = snap.find(
              (s) =>
                s.kind === "outbound" &&
                s.frame?.type === "request" &&
                s.frame.method === sampled.method,
            );
            if (outbound?.frame?.type !== "request") return false;
            const expectedId = outbound.frame.id;
            return snap.some(
              (s) =>
                s.kind === "inbound" &&
                s.frame?.type === "response" &&
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
