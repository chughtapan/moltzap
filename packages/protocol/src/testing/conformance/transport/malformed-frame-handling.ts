/**
 * Malformed bytes on the wire → the server drops or returns a typed
 * error, never crashes. Drives `sendMalformed` through a real WS and
 * asserts the observable outcome.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { arbitraryMalformedFrame } from "../../arbitraries/frames.js";
import { AgentsList } from "../../../identity/methods.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_MALFORMED_RESPONSE_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

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
