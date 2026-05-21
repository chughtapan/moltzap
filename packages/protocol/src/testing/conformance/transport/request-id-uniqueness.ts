/**
 * Request-IDs are unique per inbound response. Sends N RPCs and asserts
 * every id in the captured response stream appears exactly once.
 */
import * as fc from "fast-check";
import { Effect, type Scope } from "effect";
import { TaskList } from "../../../task/methods.js";
import { type JsonRpcId } from "../../../transport/wire.js";
import { isRequestFrame, isResponseFrame } from "../_shared/frame-mutator.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import type { CapturedFrame } from "../_shared/captures.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const REQUEST_ID_UNIQUENESS_PROPERTY = "request-id-uniqueness";
const RESPONSE_CAPTURE_CAPACITY_PER_REQUEST = 4;
const REQUEST_ID_UNIQUENESS_NUM_RUNS = 5;

interface RequestIdCounts {
  readonly outboundIds: ReadonlySet<JsonRpcId>;
  readonly inboundIds: ReadonlySet<JsonRpcId>;
  readonly inboundCount: number;
}

export function registerRequestIdUniqueness(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    REQUEST_ID_UNIQUENESS_PROPERTY,
    "every request-id appears in exactly one response",
    assertProperty(CATEGORY, REQUEST_ID_UNIQUENESS_PROPERTY, (onFailure) =>
      runRequestIdUniquenessProperty(ctx, onFailure),
    ).pipe(Effect.withSpan("registerRequestIdUniqueness")),
  );
}

function runRequestIdUniquenessProperty(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 6 }), (count) =>
          runRequestIdSample(ctx, count),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? REQUEST_ID_UNIQUENESS_NUM_RUNS,
        },
      ),
    catch: onFailure,
  });
}

function runRequestIdSample(ctx: ConformanceRunContext, count: number) {
  return Effect.runPromise(
    Effect.scoped(captureRequestIdCounts(ctx, count)).pipe(
      Effect.map((counts) => requestIdsAreUnique(counts, count)),
    ),
  );
}

function captureRequestIdCounts(
  ctx: ConformanceRunContext,
  count: number,
): Effect.Effect<RequestIdCounts, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "ru",
    });
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: count * RESPONSE_CAPTURE_CAPACITY_PER_REQUEST,
    });
    const handshakeEnd = (yield* client.snapshot).length;
    yield* sendConversationListBatch(client, count);
    return countCapturedRequestIds(
      (yield* client.snapshot).slice(handshakeEnd),
    );
  });
}

function sendConversationListBatch(
  client: TestClient,
  count: number,
): Effect.Effect<ReadonlyArray<unknown>> {
  return Effect.forEach(
    requestIndexes(count),
    () => client.sendRpc(TaskList, {}).pipe(Effect.either),
    { concurrency: count },
  );
}

function requestIndexes(count: number): ReadonlyArray<number> {
  return Array.from({ length: count }, (_, index) => index);
}

function countCapturedRequestIds(
  snapshot: ReadonlyArray<CapturedFrame>,
): RequestIdCounts {
  const outboundIds = new Set<JsonRpcId>();
  const inboundIds = new Set<JsonRpcId>();
  let inboundCount = 0;
  for (const entry of snapshot) {
    if (entry.frame === null) continue;
    if (entry.kind === "outbound" && isRequestFrame(entry.frame)) {
      outboundIds.add(entry.frame.id);
    }
    if (isInboundResponseWithId(entry)) {
      inboundIds.add(entry.frame.id);
      inboundCount += 1;
    }
  }
  return { outboundIds, inboundIds, inboundCount };
}

function isInboundResponseWithId(
  entry: CapturedFrame,
): entry is CapturedFrame & { readonly frame: { readonly id: JsonRpcId } } {
  return (
    entry.kind === "inbound" &&
    entry.frame !== null &&
    isResponseFrame(entry.frame) &&
    typeof entry.frame.id === "string"
  );
}

function requestIdsAreUnique(
  counts: RequestIdCounts,
  expected: number,
): boolean {
  if (counts.outboundIds.size !== expected) return false;
  if (counts.inboundIds.size !== counts.outboundIds.size) return false;
  if (counts.inboundCount !== counts.inboundIds.size) return false;
  for (const id of counts.outboundIds) {
    if (!counts.inboundIds.has(id)) return false;
  }
  return true;
}
