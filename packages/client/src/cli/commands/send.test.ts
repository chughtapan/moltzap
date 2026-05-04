import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCommand } from "./send.js";

import { MessagesSend } from "@moltzap/protocol";

const mockRequest = vi.fn(() => Effect.succeed({ message: { id: "msg-123" } }));

vi.mock("../socket-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../socket-client.js")>();
  return {
    ...actual,
    request: (...args: unknown[]) => mockRequest(...(args as [])),
  };
});

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

  const CONV_UUID = "00000000-0000-4000-8000-00000000abc1";

  it("sends to conversation by conv: prefix", async () => {
    await Effect.runPromise(
      sendCommand.handler({
        target: `conv:${CONV_UUID}`,
        message: "Hello world",
        replyTo: Option.none(),
      }),
    );
    expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
      conversationId: CONV_UUID,
      parts: [{ type: "text", text: "Hello world" }],
    });
  });

  it("sends to agent target without conv: prefix", async () => {
    await Effect.runPromise(
      sendCommand.handler({
        target: "agent:alice",
        message: "Hi Alice",
        replyTo: Option.none(),
      }),
    );
    expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
      to: "agent:alice",
      parts: [{ type: "text", text: "Hi Alice" }],
    });
  });

  it("includes replyToId when --reply-to is provided", async () => {
    const REPLY_MSG = "00000000-0000-4000-8000-0000000000a1";
    await Effect.runPromise(
      sendCommand.handler({
        target: `conv:${CONV_UUID}`,
        message: "Reply text",
        replyTo: Option.some(REPLY_MSG),
      }),
    );
    expect(mockRequest).toHaveBeenCalledWith(MessagesSend, {
      conversationId: CONV_UUID,
      parts: [{ type: "text", text: "Reply text" }],
      replyToId: REPLY_MSG,
    });
  });
});
