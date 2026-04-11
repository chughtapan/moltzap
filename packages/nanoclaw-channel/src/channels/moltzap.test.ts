import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@moltzap/protocol";

import {
  MoltZapChannel,
  type ContextAdapterConfig,
  type ConversationMetaLike,
  type MoltZapServiceLike,
} from "./moltzap.js";
import type { NewMessage, RegisteredGroup } from "../types.js";
import type { ChannelOpts } from "./registry.js";

type MessageHandler = (msg: Message) => void;
type VoidHandler = () => void;

class FakeMoltZapService implements MoltZapServiceLike {
  messageHandlers: MessageHandler[] = [];
  disconnectHandlers: VoidHandler[] = [];
  reconnectHandlers: VoidHandler[] = [];
  sent: Array<{ convId: string; text: string }> = [];
  connectCalled = 0;
  closeCalled = 0;
  ownAgentId: string | undefined = "agent-self";
  getContext = vi.fn(
    (_convId: string, _opts: ContextAdapterConfig): string | null => null,
  );
  private conversations = new Map<string, ConversationMetaLike>();
  private agentNames = new Map<string, string>();
  private resolveCalls: string[] = [];

  on(event: "message", handler: MessageHandler): void;
  on(event: "disconnect", handler: VoidHandler): void;
  on(event: "reconnect", handler: VoidHandler): void;
  on(event: string, handler: MessageHandler | VoidHandler): void {
    if (event === "message")
      this.messageHandlers.push(handler as MessageHandler);
    else if (event === "disconnect")
      this.disconnectHandlers.push(handler as VoidHandler);
    else if (event === "reconnect")
      this.reconnectHandlers.push(handler as VoidHandler);
  }

  async connect(): Promise<unknown> {
    this.connectCalled++;
    return {};
  }

  close(): void {
    this.closeCalled++;
  }

  async send(conversationId: string, text: string): Promise<void> {
    this.sent.push({ convId: conversationId, text });
  }

  getConversation(convId: string): ConversationMetaLike | undefined {
    return this.conversations.get(convId);
  }

  getAgentName(agentId: string): string | undefined {
    return this.agentNames.get(agentId);
  }

  async resolveAgentName(agentId: string): Promise<string> {
    this.resolveCalls.push(agentId);
    return this.agentNames.get(agentId) ?? agentId;
  }

  setConversation(id: string, meta: ConversationMetaLike): void {
    this.conversations.set(id, meta);
  }

  setAgentName(id: string, name: string): void {
    this.agentNames.set(id, name);
  }

  emitMessage(msg: Message): void {
    for (const h of this.messageHandlers) h(msg);
  }

  emitDisconnect(): void {
    for (const h of this.disconnectHandlers) h();
  }

  emitReconnect(): void {
    for (const h of this.reconnectHandlers) h();
  }

  getResolveCallCount(agentId: string): number {
    return this.resolveCalls.filter((id) => id === agentId).length;
  }
}

interface RecordedChannelOpts extends ChannelOpts {
  received: Array<{ jid: string; msg: NewMessage }>;
  metadata: Array<{
    jid: string;
    ts: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }>;
  groupsMap: Record<string, RegisteredGroup>;
}

function createRecordedOpts(): RecordedChannelOpts {
  const received: RecordedChannelOpts["received"] = [];
  const metadata: RecordedChannelOpts["metadata"] = [];
  const groupsMap: Record<string, RegisteredGroup> = {};
  return {
    onMessage: (jid, msg) => received.push({ jid, msg }),
    onChatMetadata: (jid, ts, name, channel, isGroup) =>
      metadata.push({ jid, ts, name, channel, isGroup }),
    registeredGroups: () => groupsMap,
    received,
    metadata,
    groupsMap,
  };
}

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sender: { type: "agent", id: "agent-alice" },
    seq: 1,
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-10T12:00:00.000Z",
    ...overrides,
  } as Message;
}

async function flushDispatchChain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("MoltZapChannel", () => {
  let service: FakeMoltZapService;
  let opts: RecordedChannelOpts;
  let channel: MoltZapChannel;

  beforeEach(() => {
    service = new FakeMoltZapService();
    opts = createRecordedOpts();
    channel = new MoltZapChannel(opts, service);
  });

  describe("lifecycle", () => {
    it("connect() calls through to MoltZapService and marks connected", async () => {
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(service.connectCalled).toBe(1);
      expect(channel.isConnected()).toBe(true);
    });

    it("disconnect() closes the service and clears the connected flag", async () => {
      await channel.connect();
      await channel.disconnect();
      expect(service.closeCalled).toBe(1);
      expect(channel.isConnected()).toBe(false);
    });

    it("disconnect event from the service clears the connected flag", async () => {
      await channel.connect();
      service.emitDisconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it("reconnect event from the service sets the connected flag", () => {
      service.emitReconnect();
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe("ownsJid", () => {
    it("returns true for mz: prefixed JIDs", () => {
      expect(channel.ownsJid("mz:conv-123")).toBe(true);
    });

    it("returns false for other channel JIDs", () => {
      expect(channel.ownsJid("tg:1234")).toBe(false);
      expect(channel.ownsJid("wa:5551234567")).toBe(false);
      expect(channel.ownsJid("conv-raw")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("strips the mz: prefix and forwards to service.send", async () => {
      await channel.sendMessage("mz:conv-42", "hello there");
      expect(service.sent).toEqual([
        { convId: "conv-42", text: "hello there" },
      ]);
    });

    it("throws when given a JID not owned by this channel", async () => {
      await expect(channel.sendMessage("tg:1234", "nope")).rejects.toThrow(
        /does not own jid/,
      );
    });
  });

  describe("inbound message handling", () => {
    it("maps MoltZap Message to NewMessage with mz: prefix", async () => {
      service.setConversation("conv-1", { type: "dm", name: "alice-dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({
          id: "msg-abc",
          conversationId: "conv-1",
          sender: { type: "agent", id: "agent-alice" },
          parts: [{ type: "text", text: "hi nanoclaw" }],
          createdAt: "2026-04-10T13:00:00.000Z",
        }),
      );

      await flushDispatchChain();

      expect(opts.received).toHaveLength(1);
      const { jid, msg } = opts.received[0]!;
      expect(jid).toBe("mz:conv-1");
      expect(msg).toMatchObject({
        id: "msg-abc",
        chat_jid: "mz:conv-1",
        sender: "agent-alice",
        sender_name: "Alice",
        content: "hi nanoclaw",
        timestamp: "2026-04-10T13:00:00.000Z",
        is_from_me: false,
      });
    });

    it("calls onChatMetadata before onMessage for each inbound", async () => {
      service.setConversation("conv-1", { type: "group", name: "devs" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(buildMessage({ conversationId: "conv-1" }));
      await flushDispatchChain();

      expect(opts.metadata).toHaveLength(1);
      expect(opts.metadata[0]).toMatchObject({
        jid: "mz:conv-1",
        name: "devs",
        channel: "moltzap",
        isGroup: true,
      });
    });

    it("falls back to resolveAgentName when getAgentName returns undefined", async () => {
      const svc = new FakeMoltZapService();
      svc.getAgentName = () => undefined;
      svc.setAgentName("agent-bob", "Bob");
      svc.setConversation("conv-1", { type: "dm" });

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc);

      svc.emitMessage(
        buildMessage({ sender: { type: "agent", id: "agent-bob" } }),
      );
      await flushDispatchChain();

      expect(localOpts.received).toHaveLength(1);
      expect(localOpts.received[0]!.msg.sender_name).toBe("Bob");
      expect(svc.getResolveCallCount("agent-bob")).toBe(1);
    });

    it("falls back to sender.id when both name lookups fail", async () => {
      const svc = new FakeMoltZapService();
      svc.getAgentName = () => undefined;
      svc.resolveAgentName = async (id) => id;
      svc.setConversation("conv-1", { type: "dm" });

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc);

      svc.emitMessage(
        buildMessage({ sender: { type: "agent", id: "agent-unknown" } }),
      );
      await flushDispatchChain();

      expect(localOpts.received[0]!.msg.sender_name).toBe("agent-unknown");
    });

    it("concatenates multiple text parts with newlines", async () => {
      service.setConversation("conv-1", { type: "dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({
          parts: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        }),
      );
      await flushDispatchChain();

      expect(opts.received[0]!.msg.content).toBe("line one\nline two");
    });

    it("ignores non-text parts when building content", async () => {
      service.setConversation("conv-1", { type: "dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({
          parts: [
            { type: "text", text: "caption" },
            { type: "image", url: "https://example.com/pic.png" },
          ],
        }),
      );
      await flushDispatchChain();

      expect(opts.received[0]!.msg.content).toBe("caption");
    });

    it("serializes handlers via the dispatch chain so message order is preserved", async () => {
      const svc = new FakeMoltZapService();
      svc.getAgentName = () => undefined;

      const resolvers: Array<(name: string) => void> = [];
      svc.resolveAgentName = (id: string) =>
        new Promise<string>((resolve) => {
          resolvers.push(() => resolve(id));
        });

      svc.setConversation("conv-1", { type: "dm" });
      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc);

      svc.emitMessage(buildMessage({ id: "msg-1" }));
      svc.emitMessage(buildMessage({ id: "msg-2" }));

      await flushDispatchChain();
      expect(resolvers).toHaveLength(1);
      expect(localOpts.received).toHaveLength(0);

      resolvers[0]!("agent-alice");
      await flushDispatchChain();
      expect(localOpts.received.map((r) => r.msg.id)).toEqual(["msg-1"]);
      expect(resolvers).toHaveLength(2);

      resolvers[1]!("agent-bob");
      await flushDispatchChain();
      expect(localOpts.received.map((r) => r.msg.id)).toEqual([
        "msg-1",
        "msg-2",
      ]);
    });

    it("sets is_from_me=true when sender matches ownAgentId", async () => {
      service.ownAgentId = "agent-self";
      service.setConversation("conv-1", { type: "dm" });

      service.emitMessage(
        buildMessage({ sender: { type: "agent", id: "agent-self" } }),
      );
      await flushDispatchChain();

      expect(opts.received[0]!.msg.is_from_me).toBe(true);
    });

    it("forwards replyToId as reply_to_message_id", async () => {
      service.setConversation("conv-1", { type: "dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(buildMessage({ replyToId: "msg-parent-123" }));
      await flushDispatchChain();

      expect(opts.received[0]!.msg.reply_to_message_id).toBe("msg-parent-123");
    });

    it("logs and swallows errors from the async handler", async () => {
      const svc = new FakeMoltZapService();
      svc.getAgentName = () => {
        throw new Error("boom");
      };
      svc.resolveAgentName = async () => "Alice";
      svc.setConversation("conv-1", { type: "dm" });

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc);

      svc.emitMessage(buildMessage());
      await flushDispatchChain();

      expect(localOpts.received).toHaveLength(0);

      svc.getAgentName = () => "Alice";
      svc.emitMessage(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(localOpts.received).toHaveLength(1);
      expect(localOpts.received[0]!.msg.id).toBe("msg-2");
    });
  });

  describe("eval mode (MOLTZAP_EVAL_MODE)", () => {
    it("does NOT auto-register groups when evalMode is false (default)", async () => {
      service.setConversation("conv-unknown", { type: "dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(buildMessage({ conversationId: "conv-unknown" }));
      await flushDispatchChain();

      expect(opts.groupsMap["mz:conv-unknown"]).toBeUndefined();
    });

    it("auto-registers a wildcard group on first message when evalMode is true", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-new", { type: "dm" });
      svc.setAgentName("agent-alice", "Alice");

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc, true);

      svc.emitMessage(buildMessage({ conversationId: "conv-new" }));
      await flushDispatchChain();

      const registered = localOpts.groupsMap["mz:conv-new"];
      expect(registered).toBeDefined();
      expect(registered!.trigger).toBe(".*");
      expect(registered!.requiresTrigger).toBe(false);
      expect(registered!.isMain).toBe(true);
      expect(registered!.name).toMatch(/^eval-/);
      expect(registered!.folder).toMatch(/^eval_/);
    });

    it("does not re-register a group that already exists in evalMode", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-existing", { type: "dm" });
      svc.setAgentName("agent-alice", "Alice");

      const localOpts = createRecordedOpts();
      localOpts.groupsMap["mz:conv-existing"] = {
        name: "already-here",
        folder: "already_here",
        trigger: "@Andy",
        added_at: "2026-04-01T00:00:00Z",
      };
      new MoltZapChannel(localOpts, svc, true);

      svc.emitMessage(buildMessage({ conversationId: "conv-existing" }));
      await flushDispatchChain();

      expect(localOpts.groupsMap["mz:conv-existing"]!.name).toBe(
        "already-here",
      );
      expect(localOpts.groupsMap["mz:conv-existing"]!.trigger).toBe("@Andy");
    });
  });

  describe("context adapter — group metadata injection", () => {
    it("prepends group metadata for group conversations", async () => {
      service.setConversation("conv-1", {
        type: "group",
        name: "devs",
        participants: ["agent:alice", "agent:bob", "agent:self"],
      });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({ parts: [{ type: "text", text: "Hi team" }] }),
      );
      await flushDispatchChain();

      const content = opts.received[0]!.msg.content;
      expect(content).toContain("<system-reminder>");
      expect(content).toContain("This is a group conversation.");
      expect(content).toContain("Group name: devs");
      expect(content).toContain(
        "Participants (3): agent:alice, agent:bob, agent:self",
      );
      expect(content).toContain("</system-reminder>");
      // Original message content preserved after the block.
      expect(content).toMatch(/<\/system-reminder>\n\nHi team$/);
    });

    it("does NOT prepend group metadata for DM conversations", async () => {
      service.setConversation("conv-1", { type: "dm", name: "alice-dm" });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({ parts: [{ type: "text", text: "just a dm" }] }),
      );
      await flushDispatchChain();

      const content = opts.received[0]!.msg.content;
      expect(content).toBe("just a dm");
      expect(content).not.toContain("<system-reminder>");
    });

    it("handles groups with zero known participants gracefully", async () => {
      service.setConversation("conv-1", {
        type: "group",
        name: "empty-group",
        // No participants field at all
      });
      service.setAgentName("agent-alice", "Alice");

      service.emitMessage(
        buildMessage({ parts: [{ type: "text", text: "hello" }] }),
      );
      await flushDispatchChain();

      const content = opts.received[0]!.msg.content;
      expect(content).toContain("Participants (0): (none listed)");
      expect(content).toContain("Group name: empty-group");
    });
  });

  describe("context adapter — cross-conversation injection", () => {
    const crossConvAdapter: ContextAdapterConfig = {
      type: "cross-conversation",
      maxConversations: 5,
      maxMessagesPerConv: 3,
    };

    it("calls service.getContext and prepends when contextAdapter is configured", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-1", { type: "dm" });
      svc.setAgentName("agent-alice", "Alice");
      svc.getContext.mockReturnValue(
        '<system-reminder>\nRecent updates (you are in conv:conv-1):\n@Bob (2m ago): (1 new) "capital of Freedonia is Zenda"\n</system-reminder>',
      );

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc, false, crossConvAdapter);

      svc.emitMessage(
        buildMessage({
          conversationId: "conv-1",
          parts: [{ type: "text", text: "probe" }],
        }),
      );
      await flushDispatchChain();

      expect(svc.getContext).toHaveBeenCalledWith("conv-1", crossConvAdapter);
      const content = localOpts.received[0]!.msg.content;
      expect(content).toContain("Recent updates (you are in conv:conv-1)");
      expect(content).toContain("Zenda");
      expect(content).toMatch(/<\/system-reminder>\n\nprobe$/);
    });

    it("does NOT call getContext when contextAdapter is undefined", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-1", { type: "dm" });
      svc.setAgentName("agent-alice", "Alice");

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc, false);

      svc.emitMessage(buildMessage({ conversationId: "conv-1" }));
      await flushDispatchChain();

      expect(svc.getContext).not.toHaveBeenCalled();
      expect(localOpts.received[0]!.msg.content).toBe("hello");
    });

    it("handles getContext returning null (no other conversations active)", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-1", { type: "dm" });
      svc.setAgentName("agent-alice", "Alice");
      svc.getContext.mockReturnValue(null);

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc, false, crossConvAdapter);

      svc.emitMessage(
        buildMessage({
          conversationId: "conv-1",
          parts: [{ type: "text", text: "solo" }],
        }),
      );
      await flushDispatchChain();

      expect(svc.getContext).toHaveBeenCalled();
      expect(localOpts.received[0]!.msg.content).toBe("solo");
    });

    it("orders cross-conv context before group metadata before original content", async () => {
      const svc = new FakeMoltZapService();
      svc.setConversation("conv-1", {
        type: "group",
        name: "devs",
        participants: ["agent:alice", "agent:self"],
      });
      svc.setAgentName("agent-alice", "Alice");
      svc.getContext.mockReturnValue(
        "<system-reminder>\nCROSS_CONV_BLOCK\n</system-reminder>",
      );

      const localOpts = createRecordedOpts();
      new MoltZapChannel(localOpts, svc, false, crossConvAdapter);

      svc.emitMessage(
        buildMessage({
          conversationId: "conv-1",
          parts: [{ type: "text", text: "actual message" }],
        }),
      );
      await flushDispatchChain();

      const content = localOpts.received[0]!.msg.content;
      const crossConvIdx = content.indexOf("CROSS_CONV_BLOCK");
      const groupIdx = content.indexOf("This is a group conversation.");
      const msgIdx = content.indexOf("actual message");

      expect(crossConvIdx).toBeGreaterThanOrEqual(0);
      expect(groupIdx).toBeGreaterThan(crossConvIdx);
      expect(msgIdx).toBeGreaterThan(groupIdx);
    });
  });
});
