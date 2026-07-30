/**
 * Latency — owner + participant route through a latency proxy. Owner
 * sends `agent/message/send`; participant observes ≥1 inbound message
 * event. Latency merely slows delivery; it must not drop events.
 */
import { Effect, Exit, Fiber, Stream } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import type { AgentTestClient } from "../_shared/driver/test-client.js";
import type { TaskId } from "#task";
import type { ConversationId } from "#conversation";
import { messageReceivedNotificationDefinition, messagesSend } from "#message";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  createOneOnOneConversation,
  proxyName,
  type ToxicBodyParams,
  withToxicProxy,
} from "./_helpers.js";

const LATENCY_CLIENT_TIMEOUT_MS = 6_000;

/**
 * Registers latency resilience.
 * @param ctx Context for the operation.
 */
export function registerLatencyResilience(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "latency-resilience",
    description: "fan-out delivery survives added latency + jitter",
    proxyName: proxyName("lat", ctx.seed),
    profile: defaultToxicProfile.latency,
    body: (params) =>
      runLatencyResilience(ctx, params).pipe(
        Effect.withSpan("registerLatencyResilience"),
      ),
  });
}

function runLatencyResilience(
  ctx: ConformanceRunContext,
  params: ToxicBodyParams,
) {
  return Effect.gen(function* () {
    const owner = yield* acquireLatencyClient(ctx, params, "o");
    const participant = yield* acquireLatencyClient(ctx, params, "p");
    const { taskId, conversationId } = yield* createOneOnOneConversation(
      owner,
      participant,
      "latency-resilience",
    );
    const observed = yield* waitForLatencyDelivery(
      participant.client,
      conversationId,
    ).pipe(Effect.fork);
    yield* sendLatencyProbe(
      params.attachToxic,
      owner.client,
      taskId,
      conversationId,
    );
    const delivered = yield* Fiber.await(observed);
    if (Exit.isFailure(delivered)) {
      return yield* adversityViolation(
        "latency-resilience",
        "latency toxic dropped all events",
      );
    }
  });
}

function acquireLatencyClient(
  ctx: ConformanceRunContext,
  params: ToxicBodyParams,
  suffix: string,
) {
  return acquireProxiedClient({
    ctx,
    proxy: params.proxy,
    name: `lat-${ctx.seed}-${suffix}`,
    defaultTimeoutMs: LATENCY_CLIENT_TIMEOUT_MS,
    unavailable: params.unavailable,
  });
}

function sendLatencyProbe(
  attachToxic: ToxicBodyParams["attachToxic"],
  client: AgentTestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* attachToxic;
      yield* client
        .sendRpc(messagesSend, {
          taskId,
          conversationId,
          parts: [{ type: "text", text: "lat-ping" }],
        })
        .pipe(Effect.either);
      yield* Effect.sleep("600 millis");
    }),
  );
}

function waitForLatencyDelivery(
  client: AgentTestClient,
  conversationId: ConversationId,
) {
  return client.subscribe(messageReceivedNotificationDefinition).pipe(
    Stream.filter(
      (frame) => frame.params.message.conversationId === conversationId,
    ),
    Stream.runHead,
    Effect.timeoutFail({
      duration: "2 seconds",
      onTimeout: () => "timeout" as const,
    }),
  );
}
