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
import { Effect, type Scope } from "effect";
import { Value } from "@sinclair/typebox/value";
import { arbitraryAnyCall } from "../../arbitraries/rpc.js";
import type { ArbitraryRpcCall } from "../../arbitraries/rpc.js";
import {
  responseFrameSchema,
  type RequestFrame,
  type ResponseFrame,
} from "../../../transport/wire.js";
import { isRequestFrame, isResponseFrame } from "../_shared/frame-mutator.js";
import type { CapturedFrame } from "../_shared/captures.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_MALFORMED_RESPONSE_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const ResponseFrameSchema = responseFrameSchema();

export function registerRequestWellFormedness(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "request-well-formedness",
    "valid request ⇒ server reply parses against ResponseFrameSchema",
    assertProperty(CATEGORY, "request-well-formedness", (onFailure) =>
      runRequestWellFormednessProperty(ctx, onFailure),
    ).pipe(Effect.withSpan("registerRequestWellFormedness")),
  );
}

function runRequestWellFormednessProperty(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(arbitraryAnyCall(), (call) =>
          runSampledRequestCheck(ctx, call),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_MALFORMED_RESPONSE_RUNS,
          endOnFailure: true,
        },
      ),
    catch: onFailure,
  });
}

function runSampledRequestCheck(
  ctx: ConformanceRunContext,
  call: ArbitraryRpcCall,
) {
  return Effect.runPromise(
    Effect.scoped(observeSampledCall(ctx, call)).pipe(
      Effect.map((observed) => responseWindowIsWellFormed(call, observed)),
    ),
  );
}

function observeSampledCall(
  ctx: ConformanceRunContext,
  call: ArbitraryRpcCall,
): Effect.Effect<ReadonlyArray<CapturedFrame>, unknown, Scope.Scope> {
  return Effect.gen(function* () {
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
    const handshakeEnd = (yield* client.snapshot).length;
    yield* client.sendRpc(call.definition, call.params).pipe(Effect.either);
    return (yield* client.snapshot).slice(handshakeEnd);
  });
}

function responseWindowIsWellFormed(
  call: ArbitraryRpcCall,
  observed: ReadonlyArray<CapturedFrame>,
): boolean {
  const outbound = findOutboundRequest(call, observed);
  if (outbound === null) return false;
  const replies = inboundResponses(observed);
  return (
    replies.length > 0 &&
    allResponsesValid(replies) &&
    hasResponseForRequest(replies, outbound.id)
  );
}

function findOutboundRequest(
  call: ArbitraryRpcCall,
  observed: ReadonlyArray<CapturedFrame>,
): RequestFrame | null {
  for (const captured of observed) {
    const frame = captured.frame;
    if (
      captured.kind === "outbound" &&
      frame !== null &&
      isRequestFrame(frame) &&
      frame.method === call.method
    ) {
      return frame;
    }
  }
  return null;
}

function inboundResponses(
  observed: ReadonlyArray<CapturedFrame>,
): ReadonlyArray<ResponseFrame> {
  const replies: ResponseFrame[] = [];
  for (const captured of observed) {
    const frame = captured.frame;
    if (
      captured.kind === "inbound" &&
      frame !== null &&
      isResponseFrame(frame)
    ) {
      replies.push(frame);
    }
  }
  return replies;
}

function allResponsesValid(replies: ReadonlyArray<ResponseFrame>): boolean {
  for (const reply of replies) {
    if (!Value.Check(ResponseFrameSchema, reply)) return false;
  }
  return true;
}

function hasResponseForRequest(
  replies: ReadonlyArray<ResponseFrame>,
  expectedId: RequestFrame["id"],
): boolean {
  for (const reply of replies) {
    if (reply.id === expectedId) return true;
  }
  return false;
}
