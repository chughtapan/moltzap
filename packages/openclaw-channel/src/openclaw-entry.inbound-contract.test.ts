import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "@moltzap/protocol";

// Capture handlers registered via service.on()
let capturedOnMessage: ((msg: Message) => void) | null = null;
let capturedOnRawEvent: ((event: unknown) => void) | null = null;
let capturedOnReconnect: (() => void) | null = null;
const mockSendRpc = vi.fn();
const mockSend = vi.fn();
const mockClose = vi.fn();
const mockGetAgentName = vi.fn();
const mockResolveAgentName = vi.fn();
const mockGetConversation = vi.fn();
const mockGetContext = vi.fn();

vi.mock("@moltzap/client", () => ({
  MoltZapService: vi.fn().mockImplementation(() => {
    const service = {
      connect: vi
        .fn()
        .mockResolvedValue({ conversations: [], unreadCounts: {} }),
      close: mockClose,
      ownAgentId: "agent-self",
      connected: true,
      getAgentName: mockGetAgentName,
      resolveAgentName: mockResolveAgentName,
      getConversation: mockGetConversation,
      getContext: mockGetContext,
      sendRpc: mockSendRpc,
      send: mockSend,
      startSocketServer: vi.fn(),
      stopSocketServer: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (event === "message")
          capturedOnMessage = handler as typeof capturedOnMessage;
        if (event === "rawEvent")
          capturedOnRawEvent = handler as typeof capturedOnRawEvent;
        if (event === "reconnect")
          capturedOnReconnect = handler as typeof capturedOnReconnect;
      }),
    };
    return service;
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
    capturedOnMessage = null;
    capturedOnRawEvent = null;
    capturedOnReconnect = null;
    abortController = new AbortController();
    mockDispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
    setStatusCalls = [];

    // Default mock returns
    mockGetAgentName.mockImplementation((id: string) => `name-of-${id}`);
    mockResolveAgentName.mockImplementation(
      async (id: string) => `name-of-${id}`,
    );
    mockGetConversation.mockReturnValue({
      id: "conv-200",
      type: "dm",
      name: undefined,
      participants: ["agent:agent-sender-1", "agent:agent-self"],
    });
    mockGetContext.mockReturnValue(null);

    // Start the plugin's gateway
    void moltzapChannelPlugin.gateway.startAccount({
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

    // Wait for service.on("message") to be registered
    await vi.waitFor(() => {
      expect(capturedOnMessage).not.toBeNull();
    });
  });

  afterEach(() => {
    abortController.abort();
  });

  it("calls dispatchReplyWithBufferedBlockDispatcher, not dispatchInboundMessage", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

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
    capturedOnMessage!(
      makeMessage({ parts: [{ type: "text", text: "Test body content" }] }),
    );

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
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
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingChannel).toBe("moltzap");
  });

  it("OriginatingTo is the conversationId", async () => {
    capturedOnMessage!(makeMessage({ conversationId: "conv-xyz" }));

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.OriginatingTo).toBe("conv-xyz");
  });

  it("group message includes ChatType, GroupSubject, GroupMembers", async () => {
    mockGetConversation.mockReturnValue({
      id: "conv-group-1",
      type: "group",
      name: "Project Alpha",
      participants: [
        "agent:agent-sender-1",
        "agent:agent-self",
        "agent:agent-third",
      ],
    });

    capturedOnMessage!(makeMessage({ conversationId: "conv-group-1" }));

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
    mockGetConversation.mockReturnValue({
      id: "conv-200",
      type: "dm",
      name: undefined,
      participants: ["agent:agent-sender-1", "agent:agent-self"],
    });

    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.ChatType).toBe("direct");
  });

  it("SenderName is resolved from service", async () => {
    mockGetAgentName.mockReturnValue("Atlas-Prime");

    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.SenderName).toBe("Atlas-Prime");
  });

  it("caches sender name lookups across messages", async () => {
    mockGetAgentName.mockReturnValue("cached-name");

    capturedOnMessage!(makeMessage());
    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledOnce());

    capturedOnMessage!(makeMessage({ id: "msg-101", seq: 2 }));
    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(2));

    // Both calls used getAgentName (sync cache), not resolveAgentName (async RPC)
    expect(mockResolveAgentName).not.toHaveBeenCalled();
  });

  it("passes cfg through to dispatch", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      cfg: Record<string, unknown>;
    };
    expect(dispatchArgs.cfg).toEqual(makeCfg());
  });

  it("dispatch includes a deliver callback in dispatcherOptions", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const dispatchArgs = mockDispatch.mock.calls[0]![0] as {
      dispatcherOptions: { deliver: Function };
    };
    expect(typeof dispatchArgs.dispatcherOptions.deliver).toBe("function");
  });

  it("updates status with lastInboundAt on message receipt", async () => {
    capturedOnMessage!(makeMessage());

    await vi.waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledOnce();
    });

    const inboundStatus = setStatusCalls.find((s) => "lastInboundAt" in s);
    expect(inboundStatus).toBeDefined();
    expect(inboundStatus!.accountId).toBe("test-account");
    expect(typeof inboundStatus!.lastInboundAt).toBe("number");
  });

  it("does not dispatch when channelRuntime is not provided", async () => {
    const ac2 = new AbortController();
    const dispatch2 = vi.fn();

    void moltzapChannelPlugin.gateway.startAccount({
      cfg: makeCfg(),
      accountId: "test-account-2",
      account: makeAccount(),
      abortSignal: ac2.signal,
      setStatus: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(capturedOnMessage).not.toBeNull();
    });

    capturedOnMessage!(makeMessage());

    await new Promise((r) => setTimeout(r, 100));
    expect(dispatch2).not.toHaveBeenCalled();

    ac2.abort();
  });

  it("handles multi-part text messages by joining with newlines", async () => {
    capturedOnMessage!(
      makeMessage({
        parts: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
          { type: "text", text: "Line 3" },
        ],
      }),
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

  it("BodyForAgent includes cross-conversation context when getContext returns a value", async () => {
    mockGetContext.mockReturnValue(
      '<system-reminder>\nRecent updates:\n@seller (2m ago): (1 new) "Min $4000"\n</system-reminder>',
    );

    // Need to restart with contextAdapter configured
    abortController.abort();
    abortController = new AbortController();
    mockDispatch.mockClear();
    capturedOnMessage = null;

    void moltzapChannelPlugin.gateway.startAccount({
      cfg: makeCfg(),
      accountId: "test-account",
      account: {
        ...makeAccount(),
        contextAdapter: { type: "cross-conversation" as const },
      },
      abortSignal: abortController.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      setStatus: vi.fn(),
      channelRuntime: {
        reply: { dispatchReplyWithBufferedBlockDispatcher: mockDispatch },
      },
    });

    await vi.waitFor(() => expect(capturedOnMessage).not.toBeNull());

    capturedOnMessage!(
      makeMessage({ parts: [{ type: "text", text: "What should I offer?" }] }),
    );

    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledOnce());

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.Body).toBe("What should I offer?");
    expect(ctx.BodyForAgent).toContain("<system-reminder>");
    expect(ctx.BodyForAgent).toContain("What should I offer?");
  });

  it("BodyForAgent equals Body when no contextAdapter configured", async () => {
    capturedOnMessage!(
      makeMessage({ parts: [{ type: "text", text: "Plain message" }] }),
    );

    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledOnce());

    const ctx = (
      mockDispatch.mock.calls[0]![0] as { ctx: Record<string, unknown> }
    ).ctx;
    expect(ctx.Body).toBe("Plain message");
    expect(ctx.BodyForAgent).toBe("Plain message");
    expect(mockGetContext).not.toHaveBeenCalled();
  });
});
