import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCommand } from "./send.js";

const mockRequest = vi.fn().mockResolvedValue({ message: { id: "msg-123" } });

vi.mock("../socket-client.js", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

describe("send command", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ message: { id: "msg-123" } });
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("sends to conversation by conv: prefix", async () => {
    await sendCommand.parseAsync([
      "node",
      "test",
      "conv:abc-123",
      "Hello world",
    ]);

    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
      parts: [{ type: "text", text: "Hello world" }],
    });
  });

  it("sends to agent target without conv: prefix", async () => {
    await sendCommand.parseAsync(["node", "test", "agent:alice", "Hi Alice"]);

    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      to: "agent:alice",
      parts: [{ type: "text", text: "Hi Alice" }],
    });
  });

  it("includes replyToId when --reply-to is provided", async () => {
    await sendCommand.parseAsync([
      "node",
      "test",
      "conv:abc-123",
      "Reply text",
      "--reply-to",
      "msg-original",
    ]);

    expect(mockRequest).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
      parts: [{ type: "text", text: "Reply text" }],
      replyToId: "msg-original",
    });
  });
});
