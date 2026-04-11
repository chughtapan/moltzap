import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "@moltzap/protocol";

// Capture handlers registered via service.on()
let capturedOnMessage: ((msg: Message) => void) | null = null;
const mockSendRpc = vi.fn();
const mockSend = vi.fn();
const mockSendToAgent = vi.fn();
const mockClose = vi.fn();

vi.mock("@moltzap/client", () => ({
  MoltZapService: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue({ conversations: [], unreadCounts: {} }),
    close: mockClose,
    ownAgentId: "agent-self",
    connected: true,
    getAgentName: vi.fn().mockReturnValue("Atlas"),
    resolveAgentName: vi.fn().mockResolvedValue("Atlas"),
    getConversation: vi.fn().mockReturnValue({
      id: "conv-400",
      type: "dm",
      name: undefined,
      participants: ["agent:agent-sender-1", "agent:agent-self"],
    }),
    getContext: vi.fn().mockReturnValue(null),
    sendRpc: mockSendRpc,
    send: mockSend,
    sendToAgent: mockSendToAgent,
    startSocketServer: vi.fn(),
    stopSocketServer: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (event === "message")
        capturedOnMessage = handler as typeof capturedOnMessage;
    }),
  })),
}));

import { moltzapChannelPlugin } from "./openclaw-entry.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-300",
    conversationId: "conv-400",
    sender: { type: "agent", id: "agent-sender-1" },
    seq: 1,
    parts: [{ type: "text", text: "Trigger message" }],
    createdAt: "2026-03-16T00:00:00Z",
    ...overrides,
  } as Message;
}

function makeAccount() {
  return {
    id: "delivery-test",
    apiKey: "moltzap_agent_delivery",
    serverUrl: "ws://localhost:9999",
    agentName: "bob-delivery",
  };
}

function makeCfg() {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount()],
      },
    },
  };
}

describe("Flow 6: Outbound delivery — deliver callback + sendText", () => {
  let abortController: AbortController;
  let mockDispatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnMessage = null;
    abortController = new AbortController();
    mockDispatch = vi.fn().mockResolvedValue({ queuedFinal: true });

    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookup") {
        return { agents: [{ id: "agent-sender-1", name: "Atlas" }] };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "dm" },
          participants: [
            { participant: { type: "agent", id: "agent-sender-1" } },
            { participant: { type: "agent", id: "agent-self" } },
          ],
        };
      }
      if (method === "messages/send") {
        return { message: { id: "sent-1" } };
      }
      return {};
    });

    void moltzapChannelPlugin.gateway.startAccount({
      cfg: makeCfg(),
      accountId: "delivery-test",
      account: makeAccount(),
      abortSignal: abortController.signal,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      setStatus: vi.fn(),
      channelRuntime: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
        },
      },
    });

    await vi.waitFor(() => {
      expect(capturedOnMessage).not.toBeNull();
    });
  });

  afterEach(() => {
    abortController.abort();
  });

  it("deliver callback returns true (replies routed via OriginatingChannel)", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      dispatcherOptions: {
        deliver: (payload: unknown, info?: unknown) => Promise<boolean>;
      };
    };

    const result = await dispatchArgs.dispatcherOptions.deliver(
      { text: "reply text" },
      { kind: "final" },
    );

    expect(result).toBe(true);
  });

  it("deliver callback returns true for non-final replies too", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      dispatcherOptions: {
        deliver: (payload: unknown, info?: unknown) => Promise<boolean>;
      };
    };

    const result = await dispatchArgs.dispatcherOptions.deliver(
      { text: "partial" },
      { kind: "tool" },
    );

    expect(result).toBe(true);
  });

  it("sendText uses correct conversationId from OriginatingTo", async () => {
    capturedOnMessage!(makeMessage({ conversationId: "conv-target-999" }));

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingTo).toBe("conv-target-999");
  });

  it("sendText via outbound.sendText sends to the right conversation", async () => {
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-outbound-1",
      text: "Hello from outbound",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      "conv-outbound-1",
      "Hello from outbound",
      { replyTo: undefined },
    );
  });

  it("sendText includes replyToId when present", async () => {
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-reply-1",
      text: "Reply content",
      accountId: "delivery-test",
      replyToId: "msg-original-1",
    });

    expect(result.ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith("conv-reply-1", "Reply content", {
      replyTo: "msg-original-1",
    });
  });

  it("sendText omits replyToId when not provided", async () => {
    await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-no-reply",
      text: "No reply ref",
      accountId: "delivery-test",
    });

    expect(mockSend).toHaveBeenCalledWith("conv-no-reply", "No reply ref", {
      replyTo: undefined,
    });
  });

  it("resolveTarget accepts any non-empty string", () => {
    const result = moltzapChannelPlugin.outbound.resolveTarget({
      to: "agent:nova",
      cfg: makeCfg(),
    });
    expect(result).toEqual({ ok: true, to: "agent:nova" });
  });

  it("resolveTarget accepts conversation IDs", () => {
    const result = moltzapChannelPlugin.outbound.resolveTarget({
      to: "conv-123",
      cfg: makeCfg(),
    });
    expect(result).toEqual({ ok: true, to: "conv-123" });
  });

  it("resolveTarget rejects empty strings", () => {
    const result = moltzapChannelPlugin.outbound.resolveTarget({
      to: "  ",
      cfg: makeCfg(),
    });
    expect(result.ok).toBe(false);
  });

  it("sendText with agent: target delegates to service.sendToAgent", async () => {
    mockSendToAgent.mockResolvedValue(undefined);

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "Hello nova",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);
    expect(mockSendToAgent).toHaveBeenCalledWith("nova", "Hello nova", {
      replyTo: undefined,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sendText with agent: target forwards replyToId to sendToAgent", async () => {
    mockSendToAgent.mockResolvedValue(undefined);

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "Reply text",
      accountId: "delivery-test",
      replyToId: "msg-parent-1",
    });

    expect(result.ok).toBe(true);
    expect(mockSendToAgent).toHaveBeenCalledWith("nova", "Reply text", {
      replyTo: "msg-parent-1",
    });
  });

  it("sendText with agent: target returns error when sendToAgent throws", async () => {
    mockSendToAgent.mockRejectedValue(new Error("lookup failed"));

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "Hello nova",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(false);
    expect((result as { error: Error }).error.message).toBe("lookup failed");
  });

  it("sendText returns error when client is not connected", async () => {
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "hello",
      accountId: "nonexistent-account",
    });

    expect(result.ok).toBe(false);
    expect(result.error!.message).toMatch(/not connected/i);
  });

  it("sendText returns error when send fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("Server rejected"));

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "hello",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error!.message).toBe("Server rejected");
  });

  it("stopAccount removes client from active pool", async () => {
    const beforeResult = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "before stop",
      accountId: "delivery-test",
    });
    expect(beforeResult.ok).toBe(true);

    await moltzapChannelPlugin.gateway.stopAccount({
      accountId: "delivery-test",
      log: { info: vi.fn() },
    });

    const afterResult = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "after stop",
      accountId: "delivery-test",
    });
    expect(afterResult.ok).toBe(false);
    expect(afterResult.error!.message).toMatch(/not connected/i);
  });
});
