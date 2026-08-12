import { live as it } from "@effect/vitest";
import type { HarnessTurn } from "@moltzap/client/harness-client";
import { testConversationId } from "@moltzap/client/test-utils";
import { Data, Effect } from "effect";
import { describe, expect, vi } from "vitest";
import {
  createHarnessReplyDeliver,
  type HarnessReplyDeliver,
} from "./harness-turn-delivery.js";

const FIRST_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440701",
);
const SECOND_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440702",
);
const FIRST_REPLY = "first reply";
const SECOND_REPLY = "second reply";
const RETRY_REPLY = "retry reply";
const PARTIAL_REPLY = "partial reply";

type Reply = HarnessTurn["reply"];

class HarnessDeliveryTestError extends Data.TaggedError(
  "HarnessDeliveryTestError",
)<{ readonly cause?: unknown }> {}

const makeTurn = (
  conversationId: HarnessTurn["conversationId"],
  reply: Reply,
): HarnessTurn => ({
  id: `message-${conversationId}`,
  conversationId,
  sender: { id: "sender-id", name: "Sender" },
  text: "incoming text",
  isFromMe: false,
  createdAt: "2026-08-04T00:00:00.000Z",
  contextBlocks: {},
  reply,
});

const invoke = (
  deliver: HarnessReplyDeliver,
  payload: { readonly text?: string; readonly body?: string },
  kind: string,
): Effect.Effect<boolean, HarnessDeliveryTestError> =>
  Effect.tryPromise({
    try: () => Promise.resolve(deliver(payload, { kind })),
    catch: (cause) => new HarnessDeliveryTestError({ cause }),
  });

const invokesEveryFinalDelivery = () =>
  Effect.gen(function* () {
    const reply = vi.fn<Reply>().mockReturnValue(Effect.void);
    const deliver = createHarnessReplyDeliver({
      turn: makeTurn(FIRST_CONVERSATION_ID, reply),
    });

    expect(yield* invoke(deliver, { text: FIRST_REPLY }, "final")).toBe(true);
    expect(yield* invoke(deliver, { text: SECOND_REPLY }, "final")).toBe(true);
    expect(reply.mock.calls).toEqual([[FIRST_REPLY], [SECOND_REPLY]]);
  });

const keepsOriginatingAuthority = () =>
  Effect.gen(function* () {
    const firstReply = vi.fn<Reply>().mockReturnValue(Effect.void);
    const secondReply = vi.fn<Reply>().mockReturnValue(Effect.void);
    const firstDeliver = createHarnessReplyDeliver({
      turn: makeTurn(FIRST_CONVERSATION_ID, firstReply),
    });
    const secondDeliver = createHarnessReplyDeliver({
      turn: makeTurn(SECOND_CONVERSATION_ID, secondReply),
    });

    yield* invoke(secondDeliver, { text: SECOND_REPLY }, "final");
    yield* invoke(firstDeliver, { text: FIRST_REPLY }, "final");

    expect(firstReply).toHaveBeenCalledExactlyOnceWith(FIRST_REPLY);
    expect(secondReply).toHaveBeenCalledExactlyOnceWith(SECOND_REPLY);
  });

const ignoresNonFinalAndEmptyDelivery = () =>
  Effect.gen(function* () {
    const reply = vi.fn<Reply>().mockReturnValue(Effect.void);
    const deliver = createHarnessReplyDeliver({
      turn: makeTurn(FIRST_CONVERSATION_ID, reply),
    });

    expect(yield* invoke(deliver, { text: PARTIAL_REPLY }, "tool")).toBe(true);
    expect(yield* invoke(deliver, {}, "final")).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

const retriesSameAuthorityAfterFailure = () =>
  Effect.gen(function* () {
    const reply = vi
      .fn<Reply>()
      .mockReturnValueOnce(Effect.fail(new HarnessDeliveryTestError({})))
      .mockReturnValue(Effect.void);
    const deliver = createHarnessReplyDeliver({
      turn: makeTurn(FIRST_CONVERSATION_ID, reply),
    });

    expect(yield* invoke(deliver, { text: RETRY_REPLY }, "final")).toBe(false);
    expect(yield* invoke(deliver, { text: RETRY_REPLY }, "final")).toBe(true);
    expect(reply.mock.calls).toEqual([[RETRY_REPLY], [RETRY_REPLY]]);
  });

// @agent-code-guard/regression-only: these examples pin OpenClaw's fixed final-delivery callback contract at the Harness boundary.
describe("Harness turn reply delivery", () => {
  it(
    "invokes the bound reply for every final delivery",
    invokesEveryFinalDelivery,
  );
  it(
    "keeps delivery authority bound to its originating turn",
    keepsOriginatingAuthority,
  );
  it(
    "does not invoke reply for non-final or empty delivery",
    ignoresNonFinalAndEmptyDelivery,
  );
  it(
    "reports failure and invokes the same authority again on retry",
    retriesSameAuthorityAfterFailure,
  );
});
