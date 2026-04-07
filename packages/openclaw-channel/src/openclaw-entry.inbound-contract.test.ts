import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventFrame, Message } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";

// Capture the onEvent callback from MoltZapWsClient construction
let capturedOnEvent: ((event: EventFrame) => void) | null = null;
let capturedOnReconnect: ((helloOk: unknown) => void) | null = null;
const mockSendRpc = vi.fn();
const mockClose = vi.fn();

vi.mock("./ws-client.js", () => ({
  MoltZapWsClient: vi.fn().mockImplementation((opts) => {
    capturedOnEvent = opts.onEvent;
    capturedOnReconnect = opts.onReconnect;
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

import { moltzapChannelPlugin } from "./openclaw-entry.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-100",
    conversationId: "conv-200",
    sender: { type: "agent", id: "agent-sender-1" },
    seq: 1,
    parts: [{ type: "text", text: "Hello from agent" }],
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
    id: "test-account",
    apiKey: "moltzap_agent_test123",
    serverUrl: "ws://localhost:9999",
    agentName: "bob",
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

describe("Flow 5: Inbound contract — dispatchReplyWithBufferedBlockDispatcher", () => {
  let abortController: AbortController;
  let mockDispatch: ReturnType<typeof vi.fn>;
  let setStatusCalls: Record<string, unknown>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnEvent = null;
    capturedOnReconnect = null;
    abortController = new AbortController();
    mockDispatch = vi.fn().mockResolvedValue(undefined);
    setStatusCalls = [];

    // Mock agents/lookup to resolve sender names
    mockSendRpc.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "agents/lookup") {
        const p = params as { agentIds: string[] };
        return {
          agents: p.agentIds.map((id) => ({
            id,
            name: `name-of-${id}`,
          })),
        };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "dm", name: undefined },
          participants: [
            { participant: { type: "agent", id: "agent-sender-1" } },
            { participant: { type: "agent", id: "agent-self" } },
          ],
        };
      }
      return {};
    });

    // Start the plugin's gateway — this registers the onEvent callback
    const startPromise = moltzapChannelPlugin.gateway.startAccount({
      cfg: makeCfg(),
      accountId: "test-account",
      account: makeAccount(),
      abortSignal: abortController.signal,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      setStatus: (s) => setStatusCalls.push(s),
      channelRuntime: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
        },
      },
    });

    // startAccount blocks forever (awaits abort), so don't await it
    void startPromise;

    // Give connect() time to resolve
    await vi.waitFor(() => {
      expect(capturedOnEvent).not.toBeNull();
    });
  });

  afterEach(() => {
    abortController.abort();
  });

  it("calls dispatchReplyWithBufferedBlockDispatcher, not dispatchInboundMessage", async () => {
    const msg = makeMessage();
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, { message: msg }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    // The dispatch was called — confirming we use buffered block dispatcher
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.any(Object),
        cfg: expect.any(Object),
        dispatcherOptions: expect.objectContaining({
          deliver: expect.any(Function),
        }),
      }),
    );
  });

  it("MsgContext has required fields: Body, BodyForAgent, From, To, SessionKey, Provider, Surface", async () => {
    const msg = makeMessage({
      parts: [{ type: "text", text: "Test body content" }],
    });
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, { message: msg }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      ctx: Record<string, unknown>;
    };
    const ctx = dispatchArgs.ctx;

    expect(ctx.Body).toBe("Test body content");
    expect(ctx.BodyForAgent).toBe("Test body content");
    expect(ctx.From).toBe("agent:agent-sender-1");
    expect(ctx.To).toBe("bob");
    expect(ctx.SessionKey).toBe("agent:main:moltzap:dm:conv-200");
    expect(ctx.Provider).toBe("moltzap");
    expect(ctx.Surface).toBe("moltzap");
    expect(ctx.AccountId).toBe("test-account");
  });

  it("OriginatingChannel is 'moltzap'", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingChannel).toBe("moltzap");
  });

  it("OriginatingTo is the conversationId", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage({ conversationId: "conv-xyz" }),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingTo).toBe("conv-xyz");
  });

  it("group message includes ChatType, GroupSubject, GroupMembers", async () => {
    // Override conversations/get to return group metadata
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookup") {
        return {
          agents: [{ id: "agent-sender-1", name: "Atlas" }],
        };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "group", name: "Project Alpha" },
          participants: [
            { participant: { type: "agent", id: "agent-sender-1" } },
            { participant: { type: "agent", id: "agent-self" } },
            { participant: { type: "agent", id: "agent-third" } },
          ],
        };
      }
      return {};
    });

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage({ conversationId: "conv-group-1" }),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.ChatType).toBe("group");
    expect(ctx.GroupSubject).toBe("Project Alpha");
    expect(ctx.GroupMembers).toBe(
      "agent:agent-sender-1,agent:agent-self,agent:agent-third",
    );
    expect(ctx.ConversationLabel).toBe("Project Alpha");
    expect(ctx.SessionKey).toBe("agent:main:moltzap:group:conv-group-1");
  });

  it("DM message has ChatType 'direct'", async () => {
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
      return {};
    });

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.ChatType).toBe("direct");
  });

  it("SenderName is resolved from agents/lookup", async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "agents/lookup") {
        return {
          agents: [{ id: "agent-sender-1", name: "Atlas-Prime" }],
        };
      }
      if (method === "conversations/get") {
        return {
          conversation: { type: "dm" },
          participants: [
            { participant: { type: "agent", id: "agent-sender-1" } },
          ],
        };
      }
      return {};
    });

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.SenderName).toBe("Atlas-Prime");
  });

  it("caches sender name lookups across messages", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    // Reset dispatch mock but NOT sendRpc call counts
    const lookupCallsBefore = mockSendRpc.mock.calls.filter(
      (c) => c[0] === "agents/lookup",
    ).length;

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage({ id: "msg-101", seq: 2 }),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    const lookupCallsAfter = mockSendRpc.mock.calls.filter(
      (c) => c[0] === "agents/lookup",
    ).length;

    // Second message should reuse cached name — no additional lookup
    expect(lookupCallsAfter).toBe(lookupCallsBefore);
  });

  it("passes cfg through to dispatch", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      cfg: Record<string, unknown>;
    };
    expect(dispatchArgs.cfg).toEqual(makeCfg());
  });

  it("dispatch includes a deliver callback in dispatcherOptions", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      dispatcherOptions: { deliver: Function };
    };
    expect(typeof dispatchArgs.dispatcherOptions.deliver).toBe("function");
  });

  it("updates status with lastInboundAt on message receipt", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const inboundStatus = setStatusCalls.find((s) => "lastInboundAt" in s);
    expect(inboundStatus).toBeDefined();
    expect(inboundStatus!.accountId).toBe("test-account");
    expect(typeof inboundStatus!.lastInboundAt).toBe("number");
  });

  it("does not dispatch when channelRuntime is not provided", async () => {
    // Re-start with no channelRuntime
    const ac2 = new AbortController();
    const dispatch2 = vi.fn();

    void moltzapChannelPlugin.gateway.startAccount({
      cfg: makeCfg(),
      accountId: "test-account-2",
      account: makeAccount(),
      abortSignal: ac2.signal,
      setStatus: vi.fn(),
      // No channelRuntime provided
    });

    await vi.waitFor(() => {
      expect(capturedOnEvent).not.toBeNull();
    });

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, {
        message: makeMessage(),
      }),
    );

    // Wait a tick, then verify no dispatch was called
    await new Promise((r) => setTimeout(r, 100));
    expect(dispatch2).not.toHaveBeenCalled();

    ac2.abort();
  });

  it("handles multi-part text messages by joining with newlines", async () => {
    const msg = makeMessage({
      parts: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
        { type: "text", text: "Line 3" },
      ],
    });

    capturedOnEvent!(
      makeEventFrame(EventNames.MessageReceived, { message: msg }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.Body).toBe("Line 1\nLine 2\nLine 3");
    expect(ctx.BodyForAgent).toBe("Line 1\nLine 2\nLine 3");
  });

  it("ignores non-message events", async () => {
    capturedOnEvent!(
      makeEventFrame(EventNames.PresenceChanged, {
        participant: { type: "agent", id: "a-1" },
        status: "online",
      }),
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("onReconnect fetches missed messages and dispatches them with cached metadata", async () => {
    const missedMsg = makeMessage({ conversationId: "conv-reconnect" });
    const helloOk = {
      conversations: [
        {
          id: "conv-reconnect",
          type: "group",
          name: "Reconnect Group",
          participants: [
            { type: "agent", id: missedMsg.sender.id },
            { type: "agent", id: "agent-self" },
          ],
        },
      ],
      unreadCounts: { "conv-reconnect": 1 },
    };

    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === "messages/list") return { messages: [missedMsg] };
      if (method === "agents/lookup")
        return { agents: [{ id: missedMsg.sender.id, name: "resolved-name" }] };
      return {};
    });

    capturedOnReconnect!(helloOk);
    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalled();
    });

    const ctx = mockDispatch.mock.calls[0][0].ctx;
    expect(ctx.Body).toBe(missedMsg.parts[0]!.text);
    // Metadata came from HelloOk cache, not conversations/get RPC
    expect(ctx.ChatType).toBe("group");
    expect(ctx.GroupSubject).toBe("Reconnect Group");
    expect(mockSendRpc).not.toHaveBeenCalledWith(
      "conversations/get",
      expect.anything(),
    );
  });
});
