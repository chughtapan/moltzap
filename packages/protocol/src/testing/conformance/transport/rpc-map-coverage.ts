/**
 * A representative sample of method names reaches the real server.
 * Full-set coverage is exercised by `schema-exhaustive-fuzz`; this
 * property asserts the wire path is alive for a small stratified
 * sample — cheap to re-run, catches regressions that render every RPC
 * unreachable.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  arbitraryCallFor,
  type ArbitraryRpcCall,
} from "../../arbitraries/rpc.js";
import { isRequestFrame, isResponseFrame } from "../_shared/frame-mutator.js";
import type { CapturedFrame } from "../_shared/captures.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { AgentsList, ContactsList } from "../../../identity/methods.js";
import { Connect } from "../../../network/methods.js";
import { ConversationsList } from "../../../task/methods.js";

const CATEGORY = "schema-conformance" as const;
const PROPERTY = "rpc-map-coverage";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

const COVERAGE_SAMPLE = [
  Connect.name,
  AgentsList.name,
  ConversationsList.name,
  ContactsList.name,
] as const;
type CoverageMethod = (typeof COVERAGE_SAMPLE)[number];

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerRpcMapCoverage(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "a representative sample of method names reaches a real-server response",
    assertRpcMapCoverage(ctx).pipe(Effect.withSpan("registerRpcMapCoverage")),
  );
}

function assertRpcMapCoverage(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    for (const method of COVERAGE_SAMPLE) {
      const sampled = yield* sampleCoverageCall(method, ctx.seed);
      const reached = yield* methodReachedServer(ctx, sampled);
      if (!reached) {
        return yield* Effect.fail(
          invariant(`method ${method} produced no observable response`),
        );
      }
    }
  });
}

function sampleCoverageCall(method: CoverageMethod, seed: number) {
  const [sampled] = fc.sample(arbitraryCallFor(method), { numRuns: 1, seed });
  return sampled === undefined
    ? Effect.fail(invariant(`failed to sample call for ${method}`))
    : Effect.succeed(sampled);
}

function methodReachedServer(
  ctx: ConformanceRunContext,
  sampled: ArbitraryRpcCall,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquireCoverageClient(ctx);
      const handshakeEnd = (yield* client.snapshot).length;
      yield* client
        .sendRpc(sampled.definition, sampled.params)
        .pipe(Effect.either);
      const snap = (yield* client.snapshot).slice(handshakeEnd);
      const expectedId = outboundRequestId(snap, sampled);
      return expectedId === null ? false : hasResponseFor(snap, expectedId);
    }),
  ).pipe(Effect.orElseSucceed(() => false));
}

function acquireCoverageClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "cov",
    });
    return yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    });
  });
}

function outboundRequestId(
  snap: ReadonlyArray<CapturedFrame>,
  sampled: ArbitraryRpcCall,
) {
  const outbound = snap.find((frame) => isOutboundRequest(frame, sampled));
  return outbound?.frame !== null &&
    outbound?.frame !== undefined &&
    isRequestFrame(outbound.frame)
    ? outbound.frame.id
    : null;
}

function isOutboundRequest(
  frame: CapturedFrame,
  sampled: ArbitraryRpcCall,
): boolean {
  return (
    frame.kind === "outbound" &&
    frame.frame !== null &&
    isRequestFrame(frame.frame) &&
    frame.frame.method === sampled.method
  );
}

function hasResponseFor(
  snap: ReadonlyArray<CapturedFrame>,
  expectedId: string,
) {
  return snap.some(
    (frame) =>
      frame.kind === "inbound" &&
      frame.frame !== null &&
      isResponseFrame(frame.frame) &&
      frame.frame.id === expectedId,
  );
}
