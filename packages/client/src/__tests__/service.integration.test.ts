import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  inject,
} from "vitest";
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
} from "@moltzap/server-core/test-utils";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { MoltZapService } from "../service.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");
  const server = await startCoreTestServer({ pgHost, pgPort });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopCoreTestServer();
});

beforeEach(async () => {
  await resetCoreTestDb();
});

/** Register an agent and return its credentials. */
async function registerAgent(name: string) {
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  const reg = await client.register(name);
  return { client, ...reg };
}

/** Create a MoltZapService, connect, and return it. Caller must close. */
async function connectService(apiKey: string): Promise<MoltZapService> {
  // Use baseUrl — WsClient appends /ws and converts http→ws internally
  const service = new MoltZapService({ serverUrl: baseUrl, agentKey: apiKey });
  await service.connect();
  return service;
}

/** Send a message from testClient to a conversation and wait for settle. */
async function sendAndSettle(
  client: MoltZapTestClient,
  conversationId: string,
  text: string,
) {
  await client.rpc("messages/send", {
    conversationId,
    parts: [{ type: "text", text }],
  });
  // Let the message propagate through WebSocket events
  await new Promise((r) => setTimeout(r, 500));
}

// ─── Group 1: Connection & Core API ──────────────────────────────────────────

describe("Connection & Core API", () => {
  it("connect() returns HelloOk with agentId", async () => {
    const reg = await registerAgent("svc-agent");
    const service = await connectService(reg.apiKey);

    expect(service.ownAgentId).toBe(reg.agentId);
    expect(service.connected).toBe(true);

    service.close();
    reg.client.close();
  });

  it("getConversation() is populated after connect with existing conversations", async () => {
    const regA = await registerAgent("agent-a");
    const regB = await registerAgent("agent-b");

    // Connect agent-a and create a conversation before agent-b connects as service
    await regA.client.connect(regA.apiKey);
    const conv = (await regA.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    // Now connect agent-b as MoltZapService — should see the conversation in HelloOk
    const service = await connectService(regB.apiKey);
    const found = service.getConversation(conv.conversation.id);
    expect(found).toBeDefined();
    expect(found!.type).toBe("dm");

    service.close();
    regA.client.close();
    regB.client.close();
  });

  it("on('message') fires for incoming message from another agent", async () => {
    const regSender = await registerAgent("sender");
    const regReceiver = await registerAgent("receiver");

    await regSender.client.connect(regSender.apiKey);
    const service = await connectService(regReceiver.apiKey);

    const conv = (await regSender.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regReceiver.agentId }],
    })) as { conversation: { id: string } };

    const received: unknown[] = [];
    service.on("message", (msg) => received.push(msg));

    await sendAndSettle(
      regSender.client,
      conv.conversation.id,
      "Hello receiver",
    );

    expect(received.length).toBe(1);
    const msg = received[0] as { parts: Array<{ text: string }> };
    expect(msg.parts[0]!.text).toBe("Hello receiver");

    service.close();
    regSender.client.close();
    regReceiver.client.close();
  });

  it("on('message') skips own agent's messages", async () => {
    const regA = await registerAgent("self-sender");
    const regB = await registerAgent("other");

    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);

    const conv = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    const received: unknown[] = [];
    service.on("message", (msg) => received.push(msg));

    // Send from the service (own agent) — should NOT fire on("message")
    await service.send(conv.conversation.id, "Self message");
    await new Promise((r) => setTimeout(r, 500));

    expect(received.length).toBe(0);

    service.close();
    regA.client.close();
    regB.client.close();
  });

  it("getHistory() stores received messages", async () => {
    const regSender = await registerAgent("hist-sender");
    const regReceiver = await registerAgent("hist-receiver");

    await regSender.client.connect(regSender.apiKey);
    const service = await connectService(regReceiver.apiKey);

    const conv = (await regSender.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regReceiver.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regSender.client, conv.conversation.id, "msg 1");
    await sendAndSettle(regSender.client, conv.conversation.id, "msg 2");

    const history = service.getHistory(conv.conversation.id);
    expect(history.length).toBe(2);

    service.close();
    regSender.client.close();
    regReceiver.client.close();
  });

  it("resolveAgentName() returns and caches name", async () => {
    const reg = await registerAgent("name-test");
    const service = await connectService(reg.apiKey);

    // Before resolution, getAgentName returns undefined
    expect(service.getAgentName(reg.agentId)).toBeUndefined();

    const name = await service.resolveAgentName(reg.agentId);
    expect(name).toBe("name-test");

    // After resolution, getAgentName returns cached value
    expect(service.getAgentName(reg.agentId)).toBe("name-test");

    service.close();
    reg.client.close();
  });

  it("send() delivers message to other agent", async () => {
    const regA = await registerAgent("send-a");
    const regB = await registerAgent("send-b");

    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);

    const conv = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    await service.send(conv.conversation.id, "Hello from service");

    const event = await regB.client.waitForEvent("messages/received", 5000);
    const msg = (event.data as { message: { parts: Array<{ text: string }> } })
      .message;
    expect(msg.parts[0]!.text).toBe("Hello from service");

    service.close();
    regA.client.close();
    regB.client.close();
  });
});

// ─── Group 2: Cross-Conversation Context ─────────────────────────────────────

describe("Cross-Conversation Context", () => {
  it("returns null with only one conversation active", async () => {
    const regA = await registerAgent("ctx-a");
    const regB = await registerAgent("ctx-b");

    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);

    const conv = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regB.client, conv.conversation.id, "Hello");

    // Only one conversation — no "other" conversations to report
    const ctx = service.getContext(conv.conversation.id);
    expect(ctx).toBeNull();

    service.close();
    regA.client.close();
    regB.client.close();
  });

  it("returns null when other conversations have no messages", async () => {
    const regA = await registerAgent("null-a");
    const regB = await registerAgent("null-b");
    const regC = await registerAgent("null-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    // Create conv with C but don't send any messages in it
    await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    });

    await sendAndSettle(regB.client, convB.conversation.id, "msg in B");

    const ctx = service.getContext(convB.conversation.id);
    // Conv C has no messages → no context
    expect(ctx).toBeNull();

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("returns system-reminder with new messages from other conversation", async () => {
    const regA = await registerAgent("xc-a");
    const regB = await registerAgent("xc-b");
    const regC = await registerAgent("xc-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    // Send message in conv C
    await sendAndSettle(regC.client, convC.conversation.id, "Hello from C");

    // Get context from conv B's perspective — should see conv C's message
    const ctx = service.getContext(convB.conversation.id);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("<system-reminder>");
    expect(ctx).toContain("</system-reminder>");
    expect(ctx).toContain("Hello from C");

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("format matches @name (Xm ago): (N new) pattern", async () => {
    const regA = await registerAgent("fmt-a");
    const regB = await registerAgent("fmt-b");
    const regC = await registerAgent("fmt-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    // Resolve C's name so it appears in context
    await service.resolveAgentName(regC.agentId);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regC.client, convC.conversation.id, "Test message");

    const ctx = service.getContext(convB.conversation.id)!;
    expect(ctx).toMatch(/@fmt-c \(\d+m ago\): \(1 new\) "Test message"/);

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("truncates long messages at 120 chars", async () => {
    const regA = await registerAgent("trunc-a");
    const regB = await registerAgent("trunc-b");
    const regC = await registerAgent("trunc-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    const longMsg = "A".repeat(500);
    await sendAndSettle(regC.client, convC.conversation.id, longMsg);

    const ctx = service.getContext(convB.conversation.id)!;
    // The preview should be truncated — full 500-char message should not appear
    expect(ctx).not.toContain("A".repeat(500));
    expect(ctx.length).toBeLessThan(500);

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("advances markers — second call returns null", async () => {
    const regA = await registerAgent("mark-a");
    const regB = await registerAgent("mark-b");
    const regC = await registerAgent("mark-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regC.client, convC.conversation.id, "Once");

    const first = service.getContext(convB.conversation.id);
    expect(first).not.toBeNull();

    // Second call — no new messages since marker advanced
    const second = service.getContext(convB.conversation.id);
    expect(second).toBeNull();

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("markers are per-viewing-conversation", async () => {
    const regA = await registerAgent("perv-a");
    const regB = await registerAgent("perv-b");
    const regC = await registerAgent("perv-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    // Send message in conv C
    await sendAndSettle(regC.client, convC.conversation.id, "Shared update");

    // Conv B views — sees the update, marker advances
    const fromB = service.getContext(convB.conversation.id);
    expect(fromB).not.toBeNull();
    expect(fromB).toContain("Shared update");

    // Conv B's marker advanced, so second call returns null
    expect(service.getContext(convB.conversation.id)).toBeNull();

    // Send message in conv B
    await sendAndSettle(regB.client, convB.conversation.id, "B update");

    // Conv C views — should see BOTH conv C's message hasn't been "seen" from C's perspective
    // AND conv B's new message
    const fromC = service.getContext(convC.conversation.id);
    expect(fromC).not.toBeNull();
    expect(fromC).toContain("B update");

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("multiple other conversations appear in context", async () => {
    const regA = await registerAgent("multi-a");
    const regB = await registerAgent("multi-b");
    const regC = await registerAgent("multi-c");
    const regD = await registerAgent("multi-d");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    await regD.client.connect(regD.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };
    const convD = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regD.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regC.client, convC.conversation.id, "From C");
    await sendAndSettle(regD.client, convD.conversation.id, "From D");

    const ctx = service.getContext(convB.conversation.id)!;
    expect(ctx).toContain("From C");
    expect(ctx).toContain("From D");

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
    regD.client.close();
  });

  it("maxConversations limits output", async () => {
    const regA = await registerAgent("lim-a");
    const agents = await Promise.all(
      ["lim-b", "lim-c", "lim-d", "lim-e"].map((n) => registerAgent(n)),
    );
    for (const a of agents) await a.client.connect(a.apiKey);

    const service = await connectService(regA.apiKey);

    const convs = [];
    for (const a of agents) {
      const conv = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: a.agentId }],
      })) as { conversation: { id: string } };
      convs.push(conv.conversation.id);
    }

    // Send messages in all 4 other conversations
    for (let i = 0; i < agents.length; i++) {
      await sendAndSettle(agents[i]!.client, convs[i]!, `Msg from ${i}`);
    }

    // Limit to 2 conversations
    const ctx = service.getContext(convs[0]!, {
      type: "cross-conversation",
      maxConversations: 2,
    })!;
    const lines = ctx.split("\n").filter((l) => l.startsWith("@"));
    expect(lines.length).toBe(2);

    service.close();
    regA.client.close();
    for (const a of agents) a.client.close();
  });

  it("excludes current conversation's messages", async () => {
    const regA = await registerAgent("excl-a");
    const regB = await registerAgent("excl-b");

    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);

    const conv = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regB.client, conv.conversation.id, "Same conv msg");

    // getContext for the same conversation — should NOT include its own messages
    const ctx = service.getContext(conv.conversation.id);
    expect(ctx).toBeNull();

    service.close();
    regA.client.close();
    regB.client.close();
  });

  it("shows resolved agent name, not UUID", async () => {
    const regA = await registerAgent("name-res-a");
    const regB = await registerAgent("name-res-b");
    const regC = await registerAgent("name-res-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    await service.resolveAgentName(regC.agentId);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regC.client, convC.conversation.id, "Named msg");

    const ctx = service.getContext(convB.conversation.id)!;
    expect(ctx).toContain("@name-res-c");
    expect(ctx).not.toContain(regC.agentId);

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("new message between calls produces new context", async () => {
    const regA = await registerAgent("new-a");
    const regB = await registerAgent("new-b");
    const regC = await registerAgent("new-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    await sendAndSettle(regC.client, convC.conversation.id, "First");
    const first = service.getContext(convB.conversation.id);
    expect(first).toContain("First");

    // Marker advanced — second call returns null
    expect(service.getContext(convB.conversation.id)).toBeNull();

    // New message arrives
    await sendAndSettle(regC.client, convC.conversation.id, "Second");
    const third = service.getContext(convB.conversation.id);
    expect(third).not.toBeNull();
    expect(third).toContain("Second");

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });

  it("ring buffer eviction — only recent messages tracked", async () => {
    const regA = await registerAgent("ring-a");
    const regB = await registerAgent("ring-b");
    const regC = await registerAgent("ring-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    // convB created to establish the conversation but not referenced directly
    await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });
    const convC = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    })) as { conversation: { id: string } };

    // Send 25 messages (exceeds default max of 20)
    for (let i = 0; i < 25; i++) {
      await regC.client.rpc("messages/send", {
        conversationId: convC.conversation.id,
        parts: [{ type: "text", text: `msg-${i}` }],
      });
    }
    await new Promise((r) => setTimeout(r, 2000));

    const history = service.getHistory(convC.conversation.id);
    expect(history.length).toBeLessThanOrEqual(20);

    // Oldest messages should have been evicted
    const texts = history.map((m) =>
      m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join(""),
    );
    expect(texts).not.toContain("msg-0");
    expect(texts).toContain("msg-24");

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });
});

// ─── Group 3: History with Session Key ───────────────────────────────────────

describe("History with session key", () => {
  it("messages/list returns both own and other agent messages", async () => {
    const regA = await registerAgent("hist-a");
    const regB = await registerAgent("hist-b");

    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);

    // Create DM between A and B
    const conv = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };

    // A sends a message
    await service.send(conv.conversation.id, "Hello from A");
    await new Promise((r) => setTimeout(r, 500));

    // B sends a message
    await sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

    // A sends another message
    await service.send(conv.conversation.id, "Follow up from A");
    await new Promise((r) => setTimeout(r, 500));

    // Fetch history via RPC (same as CLI moltzap history would do)
    const result = (await service.sendRpc("messages/list", {
      conversationId: conv.conversation.id,
      limit: 10,
    })) as {
      messages: Array<{
        senderId: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
    };

    // Should contain messages from BOTH agents
    expect(result.messages.length).toBeGreaterThanOrEqual(3);

    const senderIds = result.messages.map((m) => m.senderId);
    expect(senderIds).toContain(regA.agentId); // own messages
    expect(senderIds).toContain(regB.agentId); // other's messages

    // Verify own messages are identifiable via ownAgentId
    const ownMessages = result.messages.filter(
      (m) => m.senderId === service.ownAgentId,
    );
    expect(ownMessages.length).toBeGreaterThanOrEqual(2);

    const otherMessages = result.messages.filter(
      (m) => m.senderId === regB.agentId,
    );
    expect(otherMessages.length).toBeGreaterThanOrEqual(1);

    service.close();
    regA.client.close();
    regB.client.close();
  });

  it("group conversation history shows all participants", async () => {
    const regA = await registerAgent("grp-a");
    const regB = await registerAgent("grp-b");
    const regC = await registerAgent("grp-c");

    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);

    // Create group
    const conv = (await service.sendRpc("conversations/create", {
      type: "group",
      name: "Test Group",
      participants: [
        { type: "agent", id: regB.agentId },
        { type: "agent", id: regC.agentId },
      ],
    })) as { conversation: { id: string } };

    // Each agent sends a message
    await service.send(conv.conversation.id, "Agent A here");
    await new Promise((r) => setTimeout(r, 500));
    await sendAndSettle(regB.client, conv.conversation.id, "Agent B here");
    await sendAndSettle(regC.client, conv.conversation.id, "Agent C here");

    // Fetch history
    const result = (await service.sendRpc("messages/list", {
      conversationId: conv.conversation.id,
      limit: 10,
    })) as {
      messages: Array<{
        senderId: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
    };

    // All 3 agents should appear
    const senderIds = new Set(result.messages.map((m) => m.senderId));
    expect(senderIds.size).toBe(3);
    expect(senderIds).toContain(regA.agentId);
    expect(senderIds).toContain(regB.agentId);
    expect(senderIds).toContain(regC.agentId);

    service.close();
    regA.client.close();
    regB.client.close();
    regC.client.close();
  });
});

// ─── Group 4: Socket Server ──────────────────────────────────────────────────

describe("Socket Server", () => {
  let socketRequest: typeof import("../cli/socket-client.js").request;

  beforeAll(async () => {
    const mod = await import("../cli/socket-client.js");
    socketRequest = mod.request;
  });

  it("ping responds with agentId", async () => {
    const reg = await registerAgent("sock-ping");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    try {
      const result = (await socketRequest("ping")) as {
        ok: boolean;
        agentId: string;
      };
      expect(result.ok).toBe(true);
      expect(result.agentId).toBe(reg.agentId);
    } finally {
      service.close();
      reg.client.close();
    }
  });

  it("status returns connection info", async () => {
    const reg = await registerAgent("sock-status");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    try {
      const result = (await socketRequest("status")) as {
        agentId: string;
        connected: boolean;
      };
      expect(result.agentId).toBe(reg.agentId);
      expect(result.connected).toBe(true);
    } finally {
      service.close();
      reg.client.close();
    }
  });

  it("passthrough RPC works via socket", async () => {
    const regA = await registerAgent("sock-rpc-a");
    const regB = await registerAgent("sock-rpc-b");
    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const conv = (await socketRequest("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      expect(conv.conversation.id).toBeDefined();

      const msg = (await socketRequest("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "via socket" }],
      })) as { message: { id: string } };
      expect(msg.message.id).toBeDefined();
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
    }
  });

  it("history via socket returns messages with isOwn labels", async () => {
    const regA = await registerAgent("sock-hist-a");
    const regB = await registerAgent("sock-hist-b");
    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const conv = (await socketRequest("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      await socketRequest("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Hello from A" }],
      });
      await new Promise((r) => setTimeout(r, 500));
      await sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

      const result = (await socketRequest("history", {
        conversationId: conv.conversation.id,
        limit: 10,
      })) as {
        messages: Array<{ senderName: string; isOwn: boolean; text: string }>;
      };

      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      const ownMsgs = result.messages.filter((m) => m.isOwn);
      expect(ownMsgs.length).toBeGreaterThanOrEqual(1);
      expect(ownMsgs[0]!.senderName).toBe("you");
      const otherMsgs = result.messages.filter((m) => !m.isOwn);
      expect(otherMsgs.length).toBeGreaterThanOrEqual(1);
      expect(otherMsgs[0]!.senderName).toBe("sock-hist-b");
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
    }
  });

  it("messages stay *NEW* after getContext notification until history is read", async () => {
    const regA = await registerAgent("wm-a");
    const regB = await registerAgent("wm-b");
    const regC = await registerAgent("wm-c");
    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const convB = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      // Seller sends message in conv C
      await sendAndSettle(regC.client, convC.conversation.id, "Price is $4000");

      // System-reminder fires for conv B → advances lastNotified
      const reminder = service.getContext(convB.conversation.id, {
        type: "cross-conversation",
      });
      expect(reminder).toContain("(1 new)");

      // System-reminder won't repeat (lastNotified advanced)
      const reminder2 = service.getContext(convB.conversation.id, {
        type: "cross-conversation",
      });
      expect(reminder2).toBeNull();

      // BUT history via socket still shows *NEW* (lastRead not advanced yet)
      const hist1 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as {
        newCount: number;
        messages: Array<{ isNew: boolean; text: string }>;
      };
      expect(hist1.newCount).toBe(1);
      expect(hist1.messages[0]!.isNew).toBe(true);
      expect(hist1.messages[0]!.text).toBe("Price is $4000");

      // After reading, lastRead advances → second fetch shows 0 new
      const hist2 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(hist2.newCount).toBe(0);
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
      regC.client.close();
    }
  });

  it("new messages after history read are marked *NEW*", async () => {
    const regA = await registerAgent("wm2-a");
    const regB = await registerAgent("wm2-b");
    const regC = await registerAgent("wm2-c");
    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const convB = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      // First message
      await sendAndSettle(regC.client, convC.conversation.id, "First");
      service.getContext(convB.conversation.id, { type: "cross-conversation" });

      // Read history → advances lastRead
      const hist1 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(hist1.newCount).toBe(1); // first read: 1 new

      // Second read → 0 new (already read)
      const hist2 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(hist2.newCount).toBe(0);

      // New message arrives AFTER read
      await sendAndSettle(regC.client, convC.conversation.id, "Second");

      // Third read → 1 new (the new message)
      const hist3 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as {
        newCount: number;
        messages: Array<{ isNew: boolean; text: string }>;
      };
      expect(hist3.newCount).toBe(1);
      const newMsgs = hist3.messages.filter((m) => m.isNew);
      expect(newMsgs[0]!.text).toBe("Second");
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
      regC.client.close();
    }
  });

  it("different sessions have independent read markers", async () => {
    const regA = await registerAgent("wm3-a");
    const regB = await registerAgent("wm3-b");
    const regC = await registerAgent("wm3-c");
    const regD = await registerAgent("wm3-d");
    await regB.client.connect(regB.apiKey);
    await regC.client.connect(regC.apiKey);
    await regD.client.connect(regD.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const convB = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };
      const convD = (await service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regD.agentId }],
      })) as { conversation: { id: string } };

      // Message in conv C
      await sendAndSettle(regC.client, convC.conversation.id, "Shared update");

      // Conv B reads history → advances lastRead for convB→convC
      const histB = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(histB.newCount).toBe(1); // first read

      // Conv B reads again → 0 new
      const histB2 = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convB.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(histB2.newCount).toBe(0);

      // Conv D reads same conversation → still 1 new (independent markers)
      const histD = (await socketRequest("history", {
        conversationId: convC.conversation.id,
        sessionKey: convD.conversation.id,
        limit: 10,
      })) as { newCount: number };
      expect(histD.newCount).toBe(1);
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
      regC.client.close();
      regD.client.close();
    }
  });

  it("socket request resolves without 10s hang (timer leak regression)", async () => {
    const reg = await registerAgent("sock-timer");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    try {
      const start = performance.now();
      await socketRequest("ping");
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
    } finally {
      service.close();
      reg.client.close();
    }
  });

  it("two services use separate socket paths", async () => {
    const regA = await registerAgent("sock-multi-a");
    const regB = await registerAgent("sock-multi-b");
    const serviceA = await connectService(regA.apiKey);
    const serviceB = await connectService(regB.apiKey);
    serviceA.startSocketServer();
    serviceB.startSocketServer();
    try {
      expect(serviceA.socketPath).not.toBe(serviceB.socketPath);

      // Both respond via their own socket path
      const resultA = (await socketRequest(
        "ping",
        undefined,
        serviceA.socketPath,
      )) as { agentId: string };
      const resultB = (await socketRequest(
        "ping",
        undefined,
        serviceB.socketPath,
      )) as { agentId: string };
      expect(resultA.agentId).toBe(regA.agentId);
      expect(resultB.agentId).toBe(regB.agentId);
    } finally {
      serviceA.close();
      serviceB.close();
      regA.client.close();
      regB.client.close();
    }
  });

  it("lastRead tracks seen message IDs across reads", async () => {
    const regA = await registerAgent("sock-page-a");
    const regB = await registerAgent("sock-page-b");
    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const conv = (await socketRequest("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      // Send 3 messages from B
      for (let i = 0; i < 3; i++) {
        await sendAndSettle(
          regB.client,
          conv.conversation.id,
          `track-msg-${i}`,
        );
      }

      // First read marks all 3 as seen
      const hist1 = (await socketRequest("history", {
        conversationId: conv.conversation.id,
        sessionKey: "track-test-session",
        limit: 10,
      })) as {
        newCount: number;
        messages: Array<{ isNew: boolean; text: string }>;
      };
      expect(hist1.messages.length).toBe(3);

      // New message arrives after read
      await sendAndSettle(regB.client, conv.conversation.id, "track-msg-new");

      // Read again — only the new message should be marked new
      const hist2 = (await socketRequest("history", {
        conversationId: conv.conversation.id,
        sessionKey: "track-test-session",
        limit: 10,
      })) as {
        newCount: number;
        messages: Array<{ isNew: boolean; text: string }>;
      };
      expect(hist2.newCount).toBe(1);
      const newMsg = hist2.messages.find((m) => m.isNew);
      expect(newMsg?.text).toBe("track-msg-new");
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
    }
  });

  it("non-text message parts render as markers in socket history", async () => {
    const regA = await registerAgent("sock-attach-a");
    const regB = await registerAgent("sock-attach-b");
    await regB.client.connect(regB.apiKey);
    const service = await connectService(regA.apiKey);
    service.startSocketServer();
    try {
      const conv = (await socketRequest("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      await regB.client.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [
          { type: "text", text: "Check this out" },
          { type: "image", url: "https://example.com/photo.jpg" },
        ],
      });
      await new Promise((r) => setTimeout(r, 500));

      const result = (await socketRequest("history", {
        conversationId: conv.conversation.id,
        limit: 10,
      })) as { messages: Array<{ text: string }> };

      const msg = result.messages.find((m) =>
        m.text.includes("Check this out"),
      );
      expect(msg).toBeDefined();
      expect(msg!.text).toContain("[image]");
    } finally {
      service.close();
      regA.client.close();
      regB.client.close();
    }
  });

  it("socketPath is stable after connect (cached at startSocketServer time)", async () => {
    const reg = await registerAgent("sock-stable");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    const pathAtStart = service.socketPath;
    try {
      const result = (await socketRequest("ping", undefined, pathAtStart)) as {
        ok: boolean;
      };
      expect(result.ok).toBe(true);
    } finally {
      service.close();
      reg.client.close();
    }
  });

  it("unknown socket method rejects with error", async () => {
    const reg = await registerAgent("sock-unknown");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    try {
      await expect(
        socketRequest("nonexistent/method", { foo: "bar" }),
      ).rejects.toThrow();
    } finally {
      service.close();
      reg.client.close();
    }
  });

  it("history rejects when conversationId is missing or wrong type", async () => {
    const reg = await registerAgent("sock-validate");
    const service = await connectService(reg.apiKey);
    service.startSocketServer();
    try {
      await expect(socketRequest("history", {})).rejects.toThrow(
        "conversationId is required",
      );
      await expect(
        socketRequest("history", { conversationId: 123 }),
      ).rejects.toThrow("conversationId is required");
      await expect(
        socketRequest("history", {
          conversationId: "abc",
          limit: "not-a-number",
        }),
      ).rejects.toThrow("limit must be a number");
    } finally {
      service.close();
      reg.client.close();
    }
  });
});
