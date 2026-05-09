/**
 * Latency — owner + participant route through a latency proxy. Owner
 * sends `messages/send`; participant observes ≥1 inbound message
 * event. Latency merely slows delivery; it must not drop events.
 */
import { Effect } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { isNotificationFrame } from "../_shared/frame-mutator.js";
import { MessagesSend } from "../../../task/methods.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  createOneOnOneConversation,
  proxyName,
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
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const owner = yield* acquireProxiedClient(
          ctx,
          proxy,
          `lat-${ctx.seed}-o`,
          LATENCY_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const participant = yield* acquireProxiedClient(
          ctx,
          proxy,
          `lat-${ctx.seed}-p`,
          LATENCY_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const conversationId = yield* createOneOnOneConversation(
          owner,
          participant,
          "latency-resilience",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            yield* owner.client
              .sendRpc(MessagesSend, {
                conversationId,
                parts: [{ type: "text", text: "lat-ping" }],
              })
              .pipe(Effect.either);
            // 100ms latency + 50ms jitter → 600ms window is generous.
            yield* Effect.sleep("600 millis");
          }),
        );
        const snap = yield* participant.client.snapshot;
        const delivered = snap.filter(
          (s) =>
            s.kind === "inbound" &&
            s.frame !== null &&
            isNotificationFrame(s.frame) &&
            s.frame.method.includes("message"),
        ).length;
        if (delivered === 0) {
          return yield* Effect.fail(
            adversityViolation(
              "latency-resilience",
              "latency toxic dropped all events",
            ),
          );
        }
      }),
  });
}
