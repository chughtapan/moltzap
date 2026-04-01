import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCommand } from "./send.js";

vi.mock("../client/ws-client.js", () => {
  const mockRpc = vi.fn().mockResolvedValue({ message: { id: "msg-123" } });
  const mockConnect = vi.fn().mockResolvedValue({});
  const mockClose = vi.fn();
  return {
    WsClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      rpc: mockRpc,
      close: mockClose,
    })),
  };
});

vi.mock("../client/config.js", () => ({
  resolveAuth: vi.fn().mockReturnValue({ agentKey: "test-key" }),
}));

const { WsClient } = await import("../client/ws-client.js");

function getLastClient() {
  const calls = vi.mocked(WsClient).mock.results;
  return calls[calls.length - 1]!.value as {
    connect: ReturnType<typeof vi.fn>;
    rpc: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe("send command", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("parses: send agent:<name> <message>", async () => {
    await sendCommand.parseAsync(["node", "test", "agent:bob", "Hello agent!"]);

    const client = getLastClient();
    expect(client.rpc).toHaveBeenCalledWith("messages/send", {
      parts: [{ type: "text", text: "Hello agent!" }],
      to: "agent:bob",
    });
  });

  it("parses: send conv:<id> <message>", async () => {
    await sendCommand.parseAsync([
      "node",
      "test",
      "conv:conv_abc123",
      "Hello conv!",
    ]);

    const client = getLastClient();
    expect(client.rpc).toHaveBeenCalledWith("messages/send", {
      parts: [{ type: "text", text: "Hello conv!" }],
      conversationId: "conv_abc123",
    });
  });

  it("parses: send agent:<name> <message> --reply-to <id>", async () => {
    await sendCommand.parseAsync([
      "node",
      "test",
      "agent:bob",
      "Reply text",
      "--reply-to",
      "msg-999",
    ]);

    const client = getLastClient();
    expect(client.rpc).toHaveBeenCalledWith("messages/send", {
      parts: [{ type: "text", text: "Reply text" }],
      to: "agent:bob",
      replyToId: "msg-999",
    });
  });

  it("sends non-conv targets via the to field", async () => {
    await sendCommand.parseAsync(["node", "test", "agent:nova", "Hello nova!"]);

    const client = getLastClient();
    expect(client.rpc).toHaveBeenCalledWith("messages/send", {
      parts: [{ type: "text", text: "Hello nova!" }],
      to: "agent:nova",
    });
  });
});
