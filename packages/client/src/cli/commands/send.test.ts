import { Effect, Option } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { sendCommand } from "./send.js";

import { MessagesSend } from "@moltzap/protocol";

const it = effectIt.effect;
const CONV_UUID = "00000000-0000-4000-8000-00000000abc1";
const REPLY_MSG = "00000000-0000-4000-8000-0000000000a1";
const HELLO_WORLD = "Hello world";
const HI_ALICE = "Hi Alice";
const REPLY_TEXT = "Reply text";

const mockRequest = vi.fn(() => Effect.succeed({ message: { id: "msg-123" } }));

vi.mock("../socket-client.js", () => ({
  request: (...args: unknown[]) => mockRequest(...(args as [])),
}));

function runSendCommand(input: {
  readonly target: string;
  readonly message: string;
  readonly replyTo: Option.Option<string>;
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

  it("sends to conversation by conv: prefix", () =>
    Effect.gen(function* () {
      yield* runSendCommand({
        target: `conv:${CONV_UUID}`,
        message: HELLO_WORLD,
        replyTo: Option.none(),
      });
      expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
        conversationId: CONV_UUID,
        parts: [{ type: "text", text: HELLO_WORLD }],
      });
    }));

  it("sends to agent target without conv: prefix", () =>
    Effect.gen(function* () {
      yield* runSendCommand({
        target: "agent:alice",
        message: HI_ALICE,
        replyTo: Option.none(),
      });
      expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
        to: "agent:alice",
        parts: [{ type: "text", text: HI_ALICE }],
      });
    }));

  it("includes replyToId when --reply-to is provided", () =>
    Effect.gen(function* () {
      yield* runSendCommand({
        target: `conv:${CONV_UUID}`,
        message: REPLY_TEXT,
        replyTo: Option.some(REPLY_MSG),
      });
      expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
        conversationId: CONV_UUID,
        parts: [{ type: "text", text: REPLY_TEXT }],
        replyToId: REPLY_MSG,
      });
    }));
});
