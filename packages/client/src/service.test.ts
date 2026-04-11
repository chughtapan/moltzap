import { beforeEach, describe, expect, it } from "vitest";
import { MoltZapService } from "./service.js";

class FakeMoltZapService extends MoltZapService {
  calls: Array<{ method: string; params: unknown }> = [];
  responses = new Map<string, unknown>();

  constructor() {
    super({ serverUrl: "ws://test.invalid", agentKey: "test-key" });
  }

  override async sendRpc(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.responses.has(method)) {
      return this.responses.get(method);
    }
    throw new Error(`FakeMoltZapService: no canned response for ${method}`);
  }
}

describe("MoltZapService.sendToAgent", () => {
  let service: FakeMoltZapService;

  beforeEach(() => {
    service = new FakeMoltZapService();
    service.responses.set("agents/lookupByName", {
      agent: { id: "agent-alice-id" },
    });
    service.responses.set("conversations/create", {
      conversation: { id: "conv-alice" },
    });
    service.responses.set("messages/send", {});
  });

  it("resolves agent name, creates a DM, and sends the message on first call", async () => {
    await service.sendToAgent("alice", "hello");

    expect(service.calls).toEqual([
      { method: "agents/lookupByName", params: { name: "alice" } },
      {
        method: "conversations/create",
        params: {
          type: "dm",
          participants: [{ type: "agent", id: "agent-alice-id" }],
        },
      },
      {
        method: "messages/send",
        params: {
          conversationId: "conv-alice",
          parts: [{ type: "text", text: "hello" }],
        },
      },
    ]);
  });

  it("caches the conversation id and skips lookup on subsequent calls", async () => {
    await service.sendToAgent("alice", "first");
    service.calls = [];

    await service.sendToAgent("alice", "second");

    expect(service.calls).toEqual([
      {
        method: "messages/send",
        params: {
          conversationId: "conv-alice",
          parts: [{ type: "text", text: "second" }],
        },
      },
    ]);
  });

  it("forwards replyTo to messages/send as replyToId", async () => {
    await service.sendToAgent("alice", "reply text", { replyTo: "msg-123" });

    const sendCall = service.calls.find((c) => c.method === "messages/send");
    expect(sendCall?.params).toEqual({
      conversationId: "conv-alice",
      parts: [{ type: "text", text: "reply text" }],
      replyToId: "msg-123",
    });
  });

  it("maintains separate cache entries per agent name", async () => {
    service.responses.set("agents/lookupByName", {
      agent: { id: "agent-alice-id" },
    });
    await service.sendToAgent("alice", "hello alice");

    service.responses.set("agents/lookupByName", {
      agent: { id: "agent-bob-id" },
    });
    service.responses.set("conversations/create", {
      conversation: { id: "conv-bob" },
    });
    await service.sendToAgent("bob", "hello bob");

    service.calls = [];
    await service.sendToAgent("alice", "alice again");
    await service.sendToAgent("bob", "bob again");

    const sendCalls = service.calls.filter((c) => c.method === "messages/send");
    expect(sendCalls).toHaveLength(2);
    expect(
      (sendCalls[0]!.params as { conversationId: string }).conversationId,
    ).toBe("conv-alice");
    expect(
      (sendCalls[1]!.params as { conversationId: string }).conversationId,
    ).toBe("conv-bob");
  });

  it("propagates errors from agents/lookupByName", async () => {
    service.responses.delete("agents/lookupByName");

    await expect(service.sendToAgent("alice", "hi")).rejects.toThrow(
      /no canned response for agents\/lookupByName/,
    );
  });

  it("propagates errors from conversations/create", async () => {
    service.responses.delete("conversations/create");

    await expect(service.sendToAgent("alice", "hi")).rejects.toThrow(
      /no canned response for conversations\/create/,
    );
  });

  it("propagates errors from messages/send", async () => {
    service.responses.delete("messages/send");

    await expect(service.sendToAgent("alice", "hi")).rejects.toThrow(
      /no canned response for messages\/send/,
    );
  });
});
