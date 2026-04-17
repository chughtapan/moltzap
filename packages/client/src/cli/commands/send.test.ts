import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCommand } from "./send.js";

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

  it("sends to conversation by conv: prefix", async () => {
    await Effect.runPromise(
      sendCommand.handler({
        target: "conv:abc-123",
        message: "Hello world",
        replyTo: Option.none(),
      }),
    );
    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
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
    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      to: "agent:alice",
      parts: [{ type: "text", text: "Hi Alice" }],
    });
  });

  it("includes replyToId when --reply-to is provided", async () => {
    await Effect.runPromise(
      sendCommand.handler({
        target: "conv:abc-123",
        message: "Reply text",
        replyTo: Option.some("msg-original"),
      }),
    );
    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
      parts: [{ type: "text", text: "Reply text" }],
      replyToId: "msg-original",
    });
  });
});
