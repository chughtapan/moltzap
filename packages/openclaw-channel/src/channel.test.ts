import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventNames } from "@moltzap/protocol";
import type { EventFrame, Message } from "@moltzap/protocol";
import { MoltZapChannelPlugin } from "./channel.js";

// Mock ws-client so tests never open real WebSockets
vi.mock("./ws-client.js", () => {
  return {
    MoltZapWsClient: vi.fn().mockImplementation((opts) => {
      return {
        _opts: opts,
        connect: vi.fn().mockResolvedValue({ ok: true }),
        sendRpc: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
    }),
  };
});

const validConfig = {
  apiKey: "moltzap_agent_abc",
  serverUrl: "wss://api.moltzap.xyz",
  agentName: "atlas",
};

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sender: { type: "user", id: "u-1" },
    seq: 0,
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Message;
}

describe("MoltZapChannelPlugin", () => {
  let plugin: MoltZapChannelPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new MoltZapChannelPlugin();
  });

  it("channelId returns 'moltzap'", () => {
    expect(plugin.channelId).toBe("moltzap");
  });

  it("setup throws on invalid config", async () => {
    await expect(plugin.setup({}, vi.fn())).rejects.toThrow("missing apiKey");
  });

  it("send throws when not connected", async () => {
    await expect(plugin.send("conv-1", "hi")).rejects.toThrow(
      "MoltZap channel not connected",
    );
  });

  it("teardown succeeds when not connected", async () => {
    await expect(plugin.teardown()).resolves.toBeUndefined();
  });

  it("routes messages/received events to onInbound callback", async () => {
    const onInbound = vi.fn();
    await plugin.setup(validConfig, onInbound);

    // Get the onEvent callback that was passed to the mock client
    const { MoltZapWsClient } = await import("./ws-client.js");
    const mockConstructor = MoltZapWsClient as unknown as ReturnType<
      typeof vi.fn
    >;
    const constructorCall = mockConstructor.mock.calls[0][0];
    const onEvent = constructorCall.onEvent as (event: EventFrame) => void;

    const msg = makeMessage();
    onEvent({
      jsonrpc: "2.0",
      type: "event",
      event: EventNames.MessageReceived,
      data: { message: msg },
    } as EventFrame);

    expect(onInbound).toHaveBeenCalledOnce();
    const envelope = onInbound.mock.calls[0][0];
    expect(envelope.channel).toBe("moltzap");
    expect(envelope.text).toBe("hello");
    expect(envelope.peer.kind).toBe("user");
    expect(envelope.messageId).toBe("msg-1");
  });

  it("ignores non-message events", async () => {
    const onInbound = vi.fn();
    await plugin.setup(validConfig, onInbound);

    const { MoltZapWsClient } = await import("./ws-client.js");
    const mockConstructor = MoltZapWsClient as unknown as ReturnType<
      typeof vi.fn
    >;
    const constructorCall = mockConstructor.mock.calls[0][0];
    const onEvent = constructorCall.onEvent as (event: EventFrame) => void;

    onEvent({
      jsonrpc: "2.0",
      type: "event",
      event: EventNames.PresenceChanged,
      data: {},
    } as EventFrame);

    expect(onInbound).not.toHaveBeenCalled();
  });

  it("passes onReconnect callback to ws-client", async () => {
    await plugin.setup(validConfig, vi.fn());

    const { MoltZapWsClient } = await import("./ws-client.js");
    const mockConstructor = MoltZapWsClient as unknown as ReturnType<
      typeof vi.fn
    >;
    const constructorCall = mockConstructor.mock.calls[0][0];
    expect(constructorCall.onReconnect).toBeDefined();
    expect(typeof constructorCall.onReconnect).toBe("function");
  });
});
