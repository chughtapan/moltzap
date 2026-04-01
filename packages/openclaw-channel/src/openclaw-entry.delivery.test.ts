import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventFrame, Message } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
// Capture the onEvent callback from MoltZapWsClient construction
let capturedOnEvent: ((event: EventFrame) => void) | null = null;
const mockSendRpc = vi.fn();
const mockClose = vi.fn();

vi.mock("./ws-client.js", () => ({
  MoltZapWsClient: vi.fn().mockImplementation((opts) => {
    capturedOnEvent = opts.onEvent;
    return {
      connect: vi.fn().mockResolvedValue({
        conversations: [],
        unreadCounts: {},
      }),
      sendRpc: mockSendRpc,
      close: mockClose,
    };
  }),
}));

import {
  moltzapChannelPlugin,
  agentConversationCache,
} from "./openclaw-entry.js";

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

function makeEventFrame(event: string, data?: unknown): EventFrame {
  return {
    jsonrpc: "2.0",
    type: "event",
    event,
    data,
  } as EventFrame;
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
    agentConversationCache.clear();
    capturedOnEvent = null;
    abortController = new AbortController();
    mockDispatch = vi.fn().mockResolvedValue(undefined);

    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookup") {
        return {
          agents: [{ id: "agent-sender-1", name: "Atlas" }],
        };
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
      expect(capturedOnEvent).not.toBeNull();
    });
  });

  afterEach(() => {
    abortController.abort();
  });

  it("deliver callback returns true (replies routed via OriginatingChannel)", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

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

    // The deliver callback always returns true — delivery is via OriginatingChannel routing
    expect(result).toBe(true);
  });

  it("deliver callback returns true for non-final replies too", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

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
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage({ conversationId: "conv-target-999" }),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    // Verify the dispatch ctx has the right OriginatingTo for sendText routing
    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingTo).toBe("conv-target-999");
  });

  it("sendText via outbound.sendText sends to the right conversation", async () => {
    // First, start the account so the client is in activeClients
    // (already done in beforeEach)

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-outbound-1",
      text: "Hello from outbound",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);

    // Verify the RPC was called with the correct params
    const sendCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "messages/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![1]).toEqual({
      conversationId: "conv-outbound-1",
      parts: [{ type: "text", text: "Hello from outbound" }],
    });
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

    const sendCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "messages/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![1]).toEqual({
      conversationId: "conv-reply-1",
      parts: [{ type: "text", text: "Reply content" }],
      replyToId: "msg-original-1",
    });
  });

  it("sendText omits replyToId when not provided", async () => {
    await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-no-reply",
      text: "No reply ref",
      accountId: "delivery-test",
    });

    const sendCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "messages/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![1]).not.toHaveProperty("replyToId");
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

  it("sendText with agent: target auto-creates DM conversation", async () => {
    mockSendRpc.mockImplementation(async (method: string, _params: unknown) => {
      if (method === "agents/lookupByName") {
        return { agent: { id: "agent-nova-id" } };
      }
      if (method === "conversations/create") {
        return { conversation: { id: "conv-auto-created" } };
      }
      if (method === "messages/send") {
        return { message: { id: "sent-1" } };
      }
      if (method === "agents/lookup") {
        return { agents: [{ id: "agent-sender-1", name: "Atlas" }] };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "dm" },
          participants: [],
        };
      }
      return {};
    });

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "Hello nova",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);

    // Verify lookupByName was called
    const lookupCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "agents/lookupByName",
    );
    expect(lookupCall).toBeDefined();
    expect(lookupCall![1]).toEqual({ name: "nova" });

    // Verify conversations/create was called
    const createCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "conversations/create",
    );
    expect(createCall).toBeDefined();
    expect(createCall![1]).toEqual({
      type: "dm",
      participants: [{ type: "agent", id: "agent-nova-id" }],
    });

    // Verify message sent to the auto-created conversation
    const sendCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "messages/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![1]).toEqual({
      conversationId: "conv-auto-created",
      parts: [{ type: "text", text: "Hello nova" }],
    });
  });

  it("sendText with agent: target reuses cached conversation on second call", async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookupByName") {
        return { agent: { id: "agent-nova-id" } };
      }
      if (method === "conversations/create") {
        return { conversation: { id: "conv-cached" } };
      }
      if (method === "messages/send") {
        return { message: { id: "sent-1" } };
      }
      if (method === "agents/lookup") {
        return { agents: [{ id: "agent-sender-1", name: "Atlas" }] };
      }
      if (method === "conversations/get") {
        return { conversation: { type: "dm" }, participants: [] };
      }
      return {};
    });

    // First call — creates conversation
    await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "First message",
      accountId: "delivery-test",
    });

    mockSendRpc.mockClear();
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookupByName") {
        throw new Error("Should not call lookupByName on cached target");
      }
      if (method === "conversations/create") {
        throw new Error(
          "Should not call conversations/create on cached target",
        );
      }
      if (method === "messages/send") {
        return { message: { id: "sent-2" } };
      }
      return {};
    });

    // Second call — should reuse cache
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:nova",
      text: "Second message",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);

    // Only messages/send should have been called (no lookup or create)
    expect(mockSendRpc).toHaveBeenCalledOnce();
    expect(mockSendRpc.mock.calls[0]![0]).toBe("messages/send");
    expect(mockSendRpc.mock.calls[0]![1]).toEqual({
      conversationId: "conv-cached",
      parts: [{ type: "text", text: "Second message" }],
    });
  });

  it("sendText with agent: target where agent not found returns error", async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookupByName") {
        throw new Error("Agent not found: ghost");
      }
      if (method === "agents/lookup") {
        return { agents: [{ id: "agent-sender-1", name: "Atlas" }] };
      }
      if (method === "conversations/get") {
        return { conversation: { type: "dm" }, participants: [] };
      }
      return {};
    });

    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "agent:ghost",
      text: "Hello ghost",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error!.message).toBe("Agent not found: ghost");
  });

  it("sendText uses conversationId for non-target strings", async () => {
    mockSendRpc.mockClear();
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-plain-id",
      text: "Hello conv",
      accountId: "delivery-test",
    });

    expect(result.ok).toBe(true);
    const sendCall = mockSendRpc.mock.calls.find(
      (c) => c[0] === "messages/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![1]).toEqual({
      conversationId: "conv-plain-id",
      parts: [{ type: "text", text: "Hello conv" }],
    });
    expect(sendCall![1]).not.toHaveProperty("to");
  });

  it("sendText returns error when client is not connected", async () => {
    const result = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "hello",
      accountId: "nonexistent-account",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toMatch(/not connected/i);
  });

  it("sendText returns error when RPC fails", async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "messages/send") {
        throw new Error("Server rejected");
      }
      // Keep other mocks working
      if (method === "agents/lookup") {
        return { agents: [{ id: "a", name: "A" }] };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "dm" },
          participants: [],
        };
      }
      return {};
    });

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
    // Before stop, sendText should work
    const beforeResult = await moltzapChannelPlugin.outbound.sendText({
      cfg: makeCfg(),
      to: "conv-1",
      text: "before stop",
      accountId: "delivery-test",
    });
    expect(beforeResult.ok).toBe(true);

    // Stop the account
    await moltzapChannelPlugin.gateway.stopAccount({
      accountId: "delivery-test",
      log: { info: vi.fn() },
    });

    // After stop, sendText should fail
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
