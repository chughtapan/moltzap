/**
 * Spurious appCallback responses do not crash or poison the server.
 *
 * The server's app-callback channel uses the protocol `JsonRpcClient` to
 * correlate server-originated request ids. An inbound response with no
 * matching pending request must be ignored and the connection must remain
 * live for ordinary client RPCs.
 */
import { Duration, Effect, Either } from "effect";
import { AgentsList } from "../../../identity/methods.js";
import { responseFrame } from "../../../transport/wire.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import type { CapturedFrame } from "../_shared/captures.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "spurious-app-callback-frame-handling";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;
const SPURIOUS_QUIESCENCE_MS = 100;
const SPURIOUS_RESPONSE_ID = "spurious-app-callback-response";

export function registerSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "stray appCallback response with no matching pending ⇒ server drops & stays alive",
    assertProperty(CATEGORY, PROPERTY, (onFailure) =>
      runSpuriousAppCallbackFrameHandling(ctx, onFailure),
    ).pipe(Effect.withSpan("registerSpuriousAppCallbackFrameHandling")),
  );
}

function runSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.either(Effect.scoped(checkSpuriousResponse(ctx))).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (cause) => Effect.fail(onFailure(cause)),
        onRight: (outcome) =>
          outcome.passed ? Effect.void : Effect.fail(onFailure(outcome.reason)),
      }),
    ),
  );
}

interface SpuriousResponseOutcome {
  readonly passed: boolean;
  readonly reason: string;
}

function checkSpuriousResponse(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const client = yield* acquireSpuriousResponseClient(ctx);
    const startIndex = (yield* client.snapshot).length;
    yield* client.sendResponseFrame(
      responseFrame(SPURIOUS_RESPONSE_ID, { result: { ignored: true } }),
    );
    yield* Effect.sleep(Duration.millis(SPURIOUS_QUIESCENCE_MS));
    const unexpected = inboundFramesSince(yield* client.snapshot, startIndex);
    if (unexpected.length > 0) {
      return failed("server replied to a response frame with no pending call");
    }

    const liveness = yield* client.sendRpc(AgentsList, {}).pipe(Effect.either);
    return Either.match(liveness, {
      onLeft: (err) =>
        failed(`post-spurious liveness probe failed: ${formatUnknown(err)}`),
      onRight: () => passed(),
    });
  });
}

function acquireSpuriousResponseClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "spurious-app-callback",
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

function inboundFramesSince(
  frames: ReadonlyArray<CapturedFrame>,
  startIndex: number,
): ReadonlyArray<CapturedFrame> {
  return frames.slice(startIndex).filter((entry) => entry.kind === "inbound");
}

function passed(): SpuriousResponseOutcome {
  return { passed: true, reason: "" };
}

function failed(reason: string): SpuriousResponseOutcome {
  return { passed: false, reason };
}

function formatUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
