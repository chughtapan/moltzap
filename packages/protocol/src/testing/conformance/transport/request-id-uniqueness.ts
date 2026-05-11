/**
 * Request-IDs are unique per inbound response. Sends N RPCs and asserts
 * every id in the captured response stream appears exactly once.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { ConversationsList } from "@moltzap/protocol/task";
import { type JsonRpcId } from "@moltzap/protocol/transport";
import { isRequestFrame, isResponseFrame } from "../_shared/frame-mutator.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const REQUEST_ID_UNIQUENESS_PROPERTY = "request-id-uniqueness";
const RESPONSE_CAPTURE_CAPACITY_PER_REQUEST = 4;
const REQUEST_ID_UNIQUENESS_NUM_RUNS = 5;

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
