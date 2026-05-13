/**
 * Slicer — partial-frame splits must not corrupt payload. Owner sends
 * a message with a distinctive token; participant's snapshot contains
 * that token verbatim.
 */
import { Effect } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { isNotificationFrame } from "../_shared/frame-mutator.js";
import { MessagesSend } from "@moltzap/protocol/task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  createOneOnOneConversation,
  proxyName,
  withToxicProxy,
} from "./_helpers.js";

const ID_RADIX = 36;
const SLICER_CLIENT_TIMEOUT_MS = 8_000;

export function registerSlicerFraming(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "slicer-framing",
    description: "partial-frame slicing preserves payload byte-identity",
    proxyName: proxyName("sli", ctx.seed),
    profile: defaultToxicProfile.slicer,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const owner = yield* acquireProxiedClient(
          ctx,
          proxy,
          `sli-${ctx.seed}-o`,
          SLICER_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const participant = yield* acquireProxiedClient(
          ctx,
          proxy,
          `sli-${ctx.seed}-p`,
          SLICER_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const conversationId = yield* createOneOnOneConversation(
          owner,
          participant,
          "slicer-framing",
        );
        const token = `sli-token-${ctx.seed}-${Date.now().toString(ID_RADIX)}`;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            yield* owner.client
              .sendRpc(MessagesSend, {
                conversationId,
                parts: [{ type: "text", text: token }],
              })
              .pipe(Effect.either);
            yield* Effect.sleep("1200 millis"); // slicer fragments are slow
          }),
        );
        const snap = yield* participant.client.snapshot;
        const matched = snap.some(
          (s) =>
            s.kind === "inbound" &&
            s.frame !== null &&
            isNotificationFrame(s.frame) &&
            s.raw.includes(token),
        );
        if (!matched) {
          return yield* Effect.fail(
            adversityViolation(
              "slicer-framing",
              `token ${token} not reassembled in participant's frames`,
            ),
          );
        }
      }).pipe(Effect.withSpan("registerSlicerFraming")),
  });
}
