import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCommand } from "./send.js";

const mockSendRpc = vi.fn().mockResolvedValue({ message: { id: "msg-123" } });
const mockConnect = vi.fn().mockResolvedValue({});
const mockClose = vi.fn();

vi.mock("../../service.js", () => ({
  MoltZapService: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    sendRpc: mockSendRpc,
    close: mockClose,
  })),
}));

vi.mock("../config.js", () => ({
  resolveAuth: vi.fn().mockReturnValue({ agentKey: "test-key" }),
  getServerUrl: vi.fn().mockReturnValue("ws://localhost:9999"),
}));

describe("send command", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendRpc.mockResolvedValue({ message: { id: "msg-123" } });
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

    expect(mockSendRpc).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
      parts: [{ type: "text", text: "Hello world" }],
    });
  });

  it("sends to agent target without conv: prefix", async () => {
    await sendCommand.parseAsync(["node", "test", "agent:alice", "Hi Alice"]);

    expect(mockSendRpc).toHaveBeenCalledWith("messages/send", {
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

    expect(mockSendRpc).toHaveBeenCalledWith("messages/send", {
      conversationId: "abc-123",
      parts: [{ type: "text", text: "Reply text" }],
      replyToId: "msg-original",
    });
  });
});
