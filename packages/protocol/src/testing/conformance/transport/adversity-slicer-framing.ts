/**
 * Slicer — partial-frame splits must not corrupt payload. Owner sends
 * a message with a distinctive token; participant's snapshot contains
 * that token verbatim.
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

const ID_RADIX = 36;
const SLICER_CLIENT_TIMEOUT_MS = 8_000;

export function registerSlicerFraming(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "slicer-framing",
    description: "partial-frame slicing preserves payload byte-identity",
    proxyName: proxyName("sli", ctx.seed),
    profile: defaultToxicProfile.slicer,
    body: (params) =>
      runSlicerFraming(ctx, params).pipe(
        Effect.withSpan("registerSlicerFraming"),
      ),
  });
}

function runSlicerFraming(ctx: ConformanceRunContext, params: ToxicBodyParams) {
  return Effect.gen(function* () {
    const owner = yield* acquireSlicerClient(ctx, params, "o");
    const participant = yield* acquireSlicerClient(ctx, params, "p");
    const { taskId, conversationId } = yield* createOneOnOneConversation(
      owner,
      participant,
      "slicer-framing",
    );
    const token = `sli-token-${ctx.seed}-${Date.now().toString(ID_RADIX)}`;
    yield* sendSlicedMessage({
      attachToxic: params.attachToxic,
      client: owner.client,
      taskId,
      conversationId,
      token,
    });
    const snap = yield* participant.client.snapshot;
    if (!snap.some((frame) => containsToken(frame, token))) {
      return yield* Effect.fail(
        adversityViolation(
          "slicer-framing",
          `token ${token} not reassembled in participant's frames`,
        ),
      );
    }
  });
}

function acquireSlicerClient(
  ctx: ConformanceRunContext,
  params: ToxicBodyParams,
  suffix: string,
) {
  return acquireProxiedClient({
    ctx,
    proxy: params.proxy,
    name: `sli-${ctx.seed}-${suffix}`,
    defaultTimeoutMs: SLICER_CLIENT_TIMEOUT_MS,
    unavailable: params.unavailable,
  });
}

interface SendSlicedMessageInput {
  readonly attachToxic: ToxicBodyParams["attachToxic"];
  readonly client: TestClient;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly token: string;
}

function sendSlicedMessage(input: SendSlicedMessageInput) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* input.attachToxic;
      yield* input.client
        .sendRpc(MessagesSend, {
          taskId: input.taskId,
          conversationId: input.conversationId,
          parts: [{ type: "text", text: input.token }],
        })
        .pipe(Effect.either);
      yield* Effect.sleep("1200 millis");
    }),
  );
}

function containsToken(frame: CapturedFrame, token: string): boolean {
  return (
    frame.kind === "inbound" &&
    frame.frame !== null &&
    inboundNotificationMethod(frame.frame) !== null &&
    frame.raw.includes(token)
  );
}
