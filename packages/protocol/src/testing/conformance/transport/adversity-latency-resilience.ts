/**
 * Latency — owner + participant route through a latency proxy. Owner
 * sends `messages/send`; participant observes ≥1 inbound message
 * event. Latency merely slows delivery; it must not drop events.
 */
import { Effect } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { inboundNotificationMethod } from "../_shared/frame-mutator.js";
import type { CapturedFrame } from "../_shared/captures.js";
import type { TestClient } from "../_shared/driver/test-client.js";
import { ConversationId, MessagesSend, TaskId } from "../../../task/index.js";
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
    yield* sendLatencyProbe(
      params.attachToxic,
      owner.client,
      taskId,
      conversationId,
    );
    const snap = yield* participant.client.snapshot;
    if (snap.filter(isMessageNotification).length === 0) {
      return yield* Effect.fail(
        adversityViolation(
          "latency-resilience",
          "latency toxic dropped all events",
        ),
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
  client: TestClient,
  taskId: TaskId,
  conversationId: ConversationId,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* attachToxic;
      yield* client
        .sendRpc(MessagesSend, {
          taskId,
          conversationId,
          parts: [{ type: "text", text: "lat-ping" }],
        })
        .pipe(Effect.either);
      yield* Effect.sleep("600 millis");
    }),
  );
}

function isMessageNotification(frame: CapturedFrame): boolean {
  if (frame.kind !== "inbound" || frame.frame === null) return false;
  const method = inboundNotificationMethod(frame.frame);
  return method !== null && method.includes("message");
}
