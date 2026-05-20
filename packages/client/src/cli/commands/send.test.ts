import { Effect, Option } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { sendCommand } from "./send.js";

import { MessagesSend } from "@moltzap/protocol";
import {
  brandConversationId,
  brandMessageId,
  brandTaskId,
  type ConversationId,
  type MessageId,
  type TaskId,
} from "@moltzap/protocol/task";

const it = effectIt.effect;
const TASK_UUID = "00000000-0000-4000-8000-00000000abc2";
const CONV_UUID = "00000000-0000-4000-8000-00000000abc1";
const REPLY_MSG = "00000000-0000-4000-8000-0000000000a1";
const HELLO_WORLD = "Hello world";
const REPLY_TEXT = "Reply text";

const mockRequest = vi.fn(() => Effect.succeed({ message: { id: "msg-123" } }));

vi.mock("../socket-client.js", () => ({
  request: (...args: unknown[]) => mockRequest(...(args as [])),
}));

function runSendCommand(input: {
  readonly target: { taskId: TaskId; conversationId: ConversationId };
  readonly message: string;
  readonly replyTo: Option.Option<MessageId>;
}) {
  return sendCommand.handler(input);
}

describe("send command handler", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockImplementation(() =>
      Effect.succeed({ message: { id: "msg-123" } }),
    );
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  const taskId = brandTaskId(TASK_UUID);
  const conversationId = brandConversationId(CONV_UUID);
  const replyToId = brandMessageId(REPLY_MSG);

  it("sends to task+conversation target", () =>
    Effect.gen(function* () {
      yield* runSendCommand({
        target: { taskId, conversationId },
        message: HELLO_WORLD,
        replyTo: Option.none(),
      });
      expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: HELLO_WORLD }],
      });
    }));

  it("includes replyToId when --reply-to is provided", () =>
    Effect.gen(function* () {
      yield* runSendCommand({
        target: { taskId, conversationId },
        message: REPLY_TEXT,
        replyTo: Option.some(replyToId),
      });
      expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: REPLY_TEXT }],
        replyToId,
      });
    }));
});
