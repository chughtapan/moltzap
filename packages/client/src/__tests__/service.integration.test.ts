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

    const convB = (await service.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    })) as { conversation: { id: string } };
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
