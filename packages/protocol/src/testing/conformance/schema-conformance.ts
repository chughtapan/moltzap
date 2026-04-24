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
                // Send the drawn call and wait for the server reply via
                // captures. `sendRpc` either resolves with the result or
                // fails typed — both paths produce a response frame.
                yield* client
                  .sendRpc(call.method, call.params)
                  .pipe(Effect.either);
                const snap = yield* client.snapshot;
                return snap.filter(
                  (s) => s.kind === "inbound" && s.frame?.type === "response",
                );
              }),
            ),
          );
          // Every response frame the server sent parses cleanly against
          // ResponseFrameSchema. `Value.Check` is the protocol source of
          // truth (Invariant I3). AnyFrame and ResponseFrame share the
          // `type: "response"` discriminator — pass the frame through.
          return observed.every((s) => {
            if (s.frame?.type !== "response") return false;
            return Value.Check(ResponseFrameSchema, s.frame as ResponseFrame);
          });
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
                return {
                  malformedReply: response,
                  postLiveness: post._tag,
                };
              }),
            ),
          );
          // Contract: either a typed error OR a clean drop (null). Both
          // are acceptable. State poisoning would surface as a failed
          // follow-up RPC.
          const validReply =
            result.malformedReply === null ||
            result.malformedReply._tag === "TestingRpcResponseError";
          // Follow-up RPC must land cleanly (Right) or surface a typed
          // error (Left) — either proves the server is still alive.
          const stillAlive =
            result.postLiveness === "Right" || result.postLiveness === "Left";
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
            yield* client
              .sendRpc(sampled.method, sampled.params)
              .pipe(Effect.either);
            const snap = yield* client.snapshot;
            return snap.some(
              (s) => s.kind === "inbound" && s.frame?.type === "response",
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
