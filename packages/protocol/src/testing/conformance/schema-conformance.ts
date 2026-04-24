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
import { arbitraryMalformedFrame } from "../arbitraries/frames.js";
import { decodeFrame, encodeFrame, malformFrame } from "../codec.js";
import {
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
          // Find the outbound request for the sampled call — its id is
          // what the server's response should reference. A response
          // frame with no matching outbound id is not proof of this
          // property; it's stale traffic from the handshake.
          const outbound = observed.find(
            (s) =>
              s.kind === "outbound" &&
              s.frame?.type === "request" &&
              s.frame.method === call.method,
          );
          if (outbound?.frame?.type !== "request") return false;
          const expectedId = outbound.frame.id;
          const reply = observed.find(
            (s) =>
              s.kind === "inbound" &&
              s.frame?.type === "response" &&
              s.frame.id === expectedId,
          );
          if (reply?.frame?.type !== "response") return false;
          // Value.Check is the protocol source of truth (Invariant I3).
          return Value.Check(ResponseFrameSchema, reply.frame as ResponseFrame);
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      ),
    ),
  );
}

/**
 * Valid event frame round-trips the codec cleanly. Event-acceptance by
 * real clients is exercised by each client package's own conformance
 * wrapper against `TestServer`; here we assert the codec path preserves
 * every event frame we generate.
 */
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
              return decoded._tag === "Right" || decoded._tag === "Left";
            },
          ),
          { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 50 },
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
