/**
 * Malformed bytes on the wire → the server drops or returns a typed
 * error, never crashes. Drives `sendMalformed` through a real WS and
 * asserts the observable outcome.
 */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import {
  arbitraryMalformedFrame,
  type ArbitraryMalformedFrame,
} from "../../arbitraries/frames.js";
import { AgentsList } from "../../../identity/index.js";
import type { RpcResponseError } from "../_shared/errors.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_MALFORMED_RESPONSE_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const PROPERTY = "malformed-frame-handling";

export function registerMalformedFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "malformed frames produce typed error or drop; server stays alive",
    assertProperty(CATEGORY, PROPERTY, (onFailure) =>
      assertMalformedFrameHandling(ctx, onFailure),
    ).pipe(Effect.withSpan("registerMalformedFrameHandling")),
  );
}

function assertMalformedFrameHandling(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(arbitraryMalformedFrame(), (sample) =>
          Effect.runPromise(checkMalformedFrameSample(ctx, sample)),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_MALFORMED_RESPONSE_RUNS,
        },
      ),
    catch: onFailure,
  });
}

function checkMalformedFrameSample(
  ctx: ConformanceRunContext,
  sample: ArbitraryMalformedFrame,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquireMalformedClient(ctx);
      const malformedReply = yield* client.sendMalformed({
        baseDefinition: AgentsList,
        baseParams: {},
        kind: sample.kind,
        seed: sample.seed,
      });
      const post = yield* client.sendRpc(AgentsList, {}).pipe(Effect.either);
      return validMalformedReply(malformedReply) && postCallSucceeded(post);
    }),
  );
}

function acquireMalformedClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "mf",
    });
    return yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
      malformedQuiescenceMs: 500,
    });
  });
}

function validMalformedReply(reply: RpcResponseError | null): boolean {
  return reply === null || reply._tag === "TestingRpcResponseError";
}

function postCallSucceeded(outcome: Either.Either<unknown, unknown>): boolean {
  return Either.match(outcome, {
    onLeft: () => false,
    onRight: () => true,
  });
}
