/**
 * Valid request ⇒ valid-shape response. Drives fast-check RPC calls
 * through a real TestClient against the real server and asserts every
 * returned frame parses against `ResponseFrameSchema`.
 *
 * Carved verbatim from `conformance/schema-conformance.ts@961a5c8`;
 * registry `category` string preserved as `"schema-conformance"` so
 * post-reorg property IDs match pre-reorg.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { arbitraryAnyCall } from "../../arbitraries/rpc.js";
import {
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../../transport/wire.js";
import { isRequestFrame, isResponseFrame } from "../_shared/frame-mutator.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_MALFORMED_RESPONSE_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

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
