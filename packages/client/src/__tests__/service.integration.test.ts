import {
  describe,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  inject,
} from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
} from "@moltzap/server-core/test-utils";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { MoltZapService } from "../service.js";

/** Shorthand: run a service Effect to a Promise. The CLI + OpenClaw edges
 * do the same thing — tests sit at the same boundary. */
const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

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
function registerAgent(name: string) {
  return Effect.gen(function* () {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = yield* client.register(name);
    return { client, ...reg };
  });
}

/** Create a MoltZapService, connect, and return it. Caller must close. */
function connectService(apiKey: string): Effect.Effect<MoltZapService, Error> {
  return Effect.gen(function* () {
    // Use baseUrl — WsClient appends /ws and converts http→ws internally
    const service = new MoltZapService({
      serverUrl: baseUrl,
      agentKey: apiKey,
    });
    yield* service.connect();
    return service;
  });
}

/** Send a message from testClient to a conversation and wait for settle. */
function sendAndSettle(
  client: MoltZapTestClient,
  conversationId: string,
  text: string,
) {
  return Effect.gen(function* () {
    yield* client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text }],
    });
    // Let the message propagate through WebSocket events
    yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
  });
}

// ─── Group 1: Connection & Core API ──────────────────────────────────────────

describe("Connection & Core API", () => {
  it.live("connect() returns HelloOk with agentId", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("svc-agent");
      const service = yield* connectService(reg.apiKey);

      expect(service.ownAgentId).toBe(reg.agentId);
      expect(service.connected).toBe(true);

      service.close();
      yield* reg.client.close();
    }),
  );

  it.live(
    "getConversation() is populated after connect with existing conversations",
    () =>
      Effect.gen(function* () {
        const regA = yield* registerAgent("agent-a");
        const regB = yield* registerAgent("agent-b");

        // Connect agent-a and create a conversation before agent-b connects as service
        yield* regA.client.connect(regA.apiKey);
        const conv = (yield* regA.client.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };

        // Now connect agent-b as MoltZapService — should see the conversation in HelloOk
        const service = yield* connectService(regB.apiKey);
        const found = service.getConversation(conv.conversation.id);
        expect(found).toBeDefined();
        expect(found!.type).toBe("dm");

        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
      }),
  );

  it.live("on('message') fires for incoming message from another agent", () =>
    Effect.gen(function* () {
      const regSender = yield* registerAgent("sender");
      const regReceiver = yield* registerAgent("receiver");

      yield* regSender.client.connect(regSender.apiKey);
      const service = yield* connectService(regReceiver.apiKey);

      const conv = (yield* regSender.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regReceiver.agentId }],
      })) as { conversation: { id: string } };

      const received: unknown[] = [];
      service.on("message", (msg) => received.push(msg));

      yield* sendAndSettle(
        regSender.client,
        conv.conversation.id,
        "Hello receiver",
      );

      expect(received.length).toBe(1);
      const msg = received[0] as { parts: Array<{ text: string }> };
      expect(msg.parts[0]!.text).toBe("Hello receiver");

      service.close();
      yield* regSender.client.close();
      yield* regReceiver.client.close();
    }),
  );

  it.live("on('message') skips own agent's messages", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("self-sender");
      const regB = yield* registerAgent("other");

      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);

      const conv = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      const received: unknown[] = [];
      service.on("message", (msg) => received.push(msg));

      // Send from the service (own agent) — should NOT fire on("message")
      yield* service.send(conv.conversation.id, "Self message");
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

      expect(received.length).toBe(0);

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }),
  );

  it.live("getHistory() stores received messages", () =>
    Effect.gen(function* () {
      const regSender = yield* registerAgent("hist-sender");
      const regReceiver = yield* registerAgent("hist-receiver");

      yield* regSender.client.connect(regSender.apiKey);
      const service = yield* connectService(regReceiver.apiKey);

      const conv = (yield* regSender.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regReceiver.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regSender.client, conv.conversation.id, "msg 1");
      yield* sendAndSettle(regSender.client, conv.conversation.id, "msg 2");

      const history = service.getHistory(conv.conversation.id);
      expect(history.length).toBe(2);

      service.close();
      yield* regSender.client.close();
      yield* regReceiver.client.close();
    }),
  );

  it.live("resolveAgentName() returns and caches name", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("name-test");
      const service = yield* connectService(reg.apiKey);

      // Before resolution, getAgentName returns undefined
      expect(service.getAgentName(reg.agentId)).toBeUndefined();

      const name = yield* service.resolveAgentName(reg.agentId);
      expect(name).toBe("name-test");

      // After resolution, getAgentName returns cached value
      expect(service.getAgentName(reg.agentId)).toBe("name-test");

      service.close();
      yield* reg.client.close();
    }),
  );

  it.live("send() delivers message to other agent", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("send-a");
      const regB = yield* registerAgent("send-b");

      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);

      const conv = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      yield* service.send(conv.conversation.id, "Hello from service");

      const event = yield* regB.client.waitForEvent("messages/received", 5000);
      const msg = (
        event.data as { message: { parts: Array<{ text: string }> } }
      ).message;
      expect(msg.parts[0]!.text).toBe("Hello from service");

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }),
  );
});

// ─── Group 2: Cross-Conversation Context ─────────────────────────────────────

describe("Cross-Conversation Context", () => {
  it.live("returns null with only one conversation active", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("ctx-a");
      const regB = yield* registerAgent("ctx-b");

      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);

      const conv = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regB.client, conv.conversation.id, "Hello");

      // Only one conversation — no "other" conversations to report
      const ctx = service.getContext(conv.conversation.id);
      expect(ctx).toBeNull();

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }),
  );

  it.live("returns null when other conversations have no messages", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("null-a");
      const regB = yield* registerAgent("null-b");
      const regC = yield* registerAgent("null-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      // Create conv with C but don't send any messages in it
      yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      });

      yield* sendAndSettle(regB.client, convB.conversation.id, "msg in B");

      const ctx = service.getContext(convB.conversation.id);
      // Conv C has no messages → no context
      expect(ctx).toBeNull();

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live(
    "returns system-reminder with new messages from other conversation",
    () =>
      Effect.gen(function* () {
        const regA = yield* registerAgent("xc-a");
        const regB = yield* registerAgent("xc-b");
        const regC = yield* registerAgent("xc-c");

        yield* regB.client.connect(regB.apiKey);
        yield* regC.client.connect(regC.apiKey);
        const service = yield* connectService(regA.apiKey);

        const convB = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };

        const convC = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regC.agentId }],
        })) as { conversation: { id: string } };

        // Send message in conv C
        yield* sendAndSettle(
          regC.client,
          convC.conversation.id,
          "Hello from C",
        );

        // Get context from conv B's perspective — should see conv C's message
        const ctx = service.getContext(convB.conversation.id);
        expect(ctx).not.toBeNull();
        expect(ctx).toContain("<system-reminder>");
        expect(ctx).toContain("</system-reminder>");
        expect(ctx).toContain("Hello from C");

        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
        yield* regC.client.close();
      }),
  );

  it.live("format matches @name (Xm ago): (N new) pattern", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("fmt-a");
      const regB = yield* registerAgent("fmt-b");
      const regC = yield* registerAgent("fmt-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      // Resolve C's name so it appears in context
      yield* service.resolveAgentName(regC.agentId);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regC.client, convC.conversation.id, "Test message");

      const ctx = service.getContext(convB.conversation.id)!;
      expect(ctx).toMatch(/@fmt-c \(\d+m ago\): \(1 new\) "Test message"/);

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("truncates long messages at 120 chars", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("trunc-a");
      const regB = yield* registerAgent("trunc-b");
      const regC = yield* registerAgent("trunc-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      const longMsg = "A".repeat(500);
      yield* sendAndSettle(regC.client, convC.conversation.id, longMsg);

      const ctx = service.getContext(convB.conversation.id)!;
      // The preview should be truncated — full 500-char message should not appear
      expect(ctx).not.toContain("A".repeat(500));
      expect(ctx.length).toBeLessThan(500);

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("advances markers — second call returns null", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("mark-a");
      const regB = yield* registerAgent("mark-b");
      const regC = yield* registerAgent("mark-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regC.client, convC.conversation.id, "Once");

      const first = service.getContext(convB.conversation.id);
      expect(first).not.toBeNull();

      // Second call — no new messages since marker advanced
      const second = service.getContext(convB.conversation.id);
      expect(second).toBeNull();

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("markers are per-viewing-conversation", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("perv-a");
      const regB = yield* registerAgent("perv-b");
      const regC = yield* registerAgent("perv-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      // Send message in conv C
      yield* sendAndSettle(regC.client, convC.conversation.id, "Shared update");

      // Conv B views — sees the update, marker advances
      const fromB = service.getContext(convB.conversation.id);
      expect(fromB).not.toBeNull();
      expect(fromB).toContain("Shared update");

      // Conv B's marker advanced, so second call returns null
      expect(service.getContext(convB.conversation.id)).toBeNull();

      // Send message in conv B
      yield* sendAndSettle(regB.client, convB.conversation.id, "B update");

      // Conv C views — should see BOTH conv C's message hasn't been "seen" from C's perspective
      // AND conv B's new message
      const fromC = service.getContext(convC.conversation.id);
      expect(fromC).not.toBeNull();
      expect(fromC).toContain("B update");

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("multiple other conversations appear in context", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("multi-a");
      const regB = yield* registerAgent("multi-b");
      const regC = yield* registerAgent("multi-c");
      const regD = yield* registerAgent("multi-d");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      yield* regD.client.connect(regD.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };
      const convD = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regD.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regC.client, convC.conversation.id, "From C");
      yield* sendAndSettle(regD.client, convD.conversation.id, "From D");

      const ctx = service.getContext(convB.conversation.id)!;
      expect(ctx).toContain("From C");
      expect(ctx).toContain("From D");

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
      yield* regD.client.close();
    }),
  );

  it.live("maxConversations limits output", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("lim-a");
      const agents = yield* Effect.all(
        ["lim-b", "lim-c", "lim-d", "lim-e"].map((n) => registerAgent(n)),
        { concurrency: "unbounded" },
      );
      for (const a of agents) yield* a.client.connect(a.apiKey);

      const service = yield* connectService(regA.apiKey);

      const convs = [];
      for (const a of agents) {
        const conv = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: a.agentId }],
        })) as { conversation: { id: string } };
        convs.push(conv.conversation.id);
      }

      // Send messages in all 4 other conversations
      for (let i = 0; i < agents.length; i++) {
        yield* sendAndSettle(agents[i]!.client, convs[i]!, `Msg from ${i}`);
      }

      // Limit to 2 conversations
      const ctx = service.getContext(convs[0]!, {
        type: "cross-conversation",
        maxConversations: 2,
      })!;
      const lines = ctx.split("\n").filter((l) => l.startsWith("@"));
      expect(lines.length).toBe(2);

      service.close();
      yield* regA.client.close();
      for (const a of agents) yield* a.client.close();
    }),
  );

  it.live("excludes current conversation's messages", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("excl-a");
      const regB = yield* registerAgent("excl-b");

      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);

      const conv = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regB.client, conv.conversation.id, "Same conv msg");

      // getContext for the same conversation — should NOT include its own messages
      const ctx = service.getContext(conv.conversation.id);
      expect(ctx).toBeNull();

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }),
  );

  it.live("shows resolved agent name, not UUID", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("name-res-a");
      const regB = yield* registerAgent("name-res-b");
      const regC = yield* registerAgent("name-res-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      yield* service.resolveAgentName(regC.agentId);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regC.client, convC.conversation.id, "Named msg");

      const ctx = service.getContext(convB.conversation.id)!;
      expect(ctx).toContain("@name-res-c");
      expect(ctx).not.toContain(regC.agentId);

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("new message between calls produces new context", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("new-a");
      const regB = yield* registerAgent("new-b");
      const regC = yield* registerAgent("new-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      const convB = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      yield* sendAndSettle(regC.client, convC.conversation.id, "First");
      const first = service.getContext(convB.conversation.id);
      expect(first).toContain("First");

      // Marker advanced — second call returns null
      expect(service.getContext(convB.conversation.id)).toBeNull();

      // New message arrives
      yield* sendAndSettle(regC.client, convC.conversation.id, "Second");
      const third = service.getContext(convB.conversation.id);
      expect(third).not.toBeNull();
      expect(third).toContain("Second");

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );

  it.live("buffer stores all messages without eviction", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("ring-a");
      const regB = yield* registerAgent("ring-b");
      const regC = yield* registerAgent("ring-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      });
      const convC = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      })) as { conversation: { id: string } };

      for (let i = 0; i < 25; i++) {
        yield* regC.client.rpc("messages/send", {
          conversationId: convC.conversation.id,
          parts: [{ type: "text", text: `msg-${i}` }],
        });
      }
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 2000)));

      const history = service.getHistory(convC.conversation.id);
      expect(history.length).toBe(25);

      const texts = history.map((m) =>
        m.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join(""),
      );
      expect(texts).toContain("msg-0");
      expect(texts).toContain("msg-24");

      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );
});

// ─── Group 2b: peekFullMessages ──────────────────────────────────────────────

describe("peekFullMessages", () => {
  it.live(
    "returns full messages from other conversations sorted by timestamp",
    () =>
      Effect.gen(function* () {
        const regA = yield* registerAgent("pfm-a");
        const regB = yield* registerAgent("pfm-b");
        const regC = yield* registerAgent("pfm-c");

        yield* regB.client.connect(regB.apiKey);
        yield* regC.client.connect(regC.apiKey);
        const service = yield* connectService(regA.apiKey);

        const convB = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };

        const convC = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regC.agentId }],
        })) as { conversation: { id: string } };

        yield* sendAndSettle(regC.client, convC.conversation.id, "from C");
        yield* sendAndSettle(regB.client, convB.conversation.id, "from B");

        const { messages } = service.peekFullMessages(convB.conversation.id);

        expect(messages.length).toBeGreaterThanOrEqual(1);
        // convC message should appear (it's a different conversation)
        const texts = messages.map((m) => m.text);
        expect(texts).toContain("from C");
        // Messages sorted chronologically — "from C" sent before "from B"
        const cIdx = texts.indexOf("from C");
        expect(cIdx).toBeGreaterThanOrEqual(0);

        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
        yield* regC.client.close();
      }),
  );

  it.live("returns all messages without artificial caps", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("nocap-a");
      const agents = [];
      for (let i = 0; i < 7; i++) {
        const reg = yield* registerAgent(`nocap-b${i}`);
        yield* reg.client.connect(reg.apiKey);
        agents.push(reg);
      }
      const service = yield* connectService(regA.apiKey);

      const convIds: string[] = [];
      for (const agent of agents) {
        const conv = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: agent.agentId }],
        })) as { conversation: { id: string } };
        convIds.push(conv.conversation.id);
        yield* sendAndSettle(
          agent.client,
          conv.conversation.id,
          `hi from ${agent.agentId.slice(0, 8)}`,
        );
      }

      // Peek from the perspective of conv 0 — should see messages from all 6 other convs
      const { messages } = service.peekFullMessages(convIds[0]!);
      expect(messages.length).toBeGreaterThanOrEqual(6);

      service.close();
      yield* regA.client.close();
      for (const a of agents) yield* a.client.close();
    }),
  );

  it.live(
    "commit advances markers — second peek returns only new messages",
    () =>
      Effect.gen(function* () {
        const regA = yield* registerAgent("commit-a");
        const regB = yield* registerAgent("commit-b");
        const regC = yield* registerAgent("commit-c");

        yield* regB.client.connect(regB.apiKey);
        yield* regC.client.connect(regC.apiKey);
        const service = yield* connectService(regA.apiKey);

        const convB = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };

        const convC = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regC.agentId }],
        })) as { conversation: { id: string } };

        yield* sendAndSettle(regC.client, convC.conversation.id, "old msg");

        const first = service.peekFullMessages(convB.conversation.id);
        expect(first.messages.length).toBeGreaterThanOrEqual(1);
        first.commit();

        // Peek again — old message should be gone
        const second = service.peekFullMessages(convB.conversation.id);
        expect(second.messages.length).toBe(0);

        // Send a new message — should appear
        yield* sendAndSettle(regC.client, convC.conversation.id, "new msg");
        const third = service.peekFullMessages(convB.conversation.id);
        expect(third.messages.length).toBeGreaterThanOrEqual(1);
        expect(third.messages.map((m) => m.text)).toContain("new msg");

        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
        yield* regC.client.close();
      }),
  );
});

// ─── Group 3: History with Session Key ───────────────────────────────────────

describe("History with session key", () => {
  it.live("messages/list returns both own and other agent messages", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("hist-a");
      const regB = yield* registerAgent("hist-b");

      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);

      // Create DM between A and B
      const conv = (yield* service.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      })) as { conversation: { id: string } };

      // A sends a message
      yield* service.send(conv.conversation.id, "Hello from A");
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

      // B sends a message
      yield* sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

      // A sends another message
      yield* service.send(conv.conversation.id, "Follow up from A");
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

      // Fetch history via RPC (same as CLI moltzap history would do)
      const result = (yield* service.sendRpc("messages/list", {
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
      yield* regA.client.close();
      yield* regB.client.close();
    }),
  );

  it.live("group conversation history shows all participants", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("grp-a");
      const regB = yield* registerAgent("grp-b");
      const regC = yield* registerAgent("grp-c");

      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);

      // Create group
      const conv = (yield* service.sendRpc("conversations/create", {
        type: "group",
        name: "Test Group",
        participants: [
          { type: "agent", id: regB.agentId },
          { type: "agent", id: regC.agentId },
        ],
      })) as { conversation: { id: string } };

      // Each agent sends a message
      yield* service.send(conv.conversation.id, "Agent A here");
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
      yield* sendAndSettle(regB.client, conv.conversation.id, "Agent B here");
      yield* sendAndSettle(regC.client, conv.conversation.id, "Agent C here");

      // Fetch history
      const result = (yield* service.sendRpc("messages/list", {
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
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }),
  );
});

// ─── Group 4: Socket Server ──────────────────────────────────────────────────

describe("Socket Server", () => {
  // Socket client now returns Effects — tests wrap with `run()` to match
  // the old `await socketRequest(...)` shape without restructuring assertions.
  let socketRequest: (
    method: string,
    params?: Record<string, unknown>,
    socketPath?: string,
  ) => Promise<unknown>;

  beforeAll(async () => {
    const mod = await import("../cli/socket-client.js");
    socketRequest = (method, params, socketPath) =>
      run(mod.request(method, params, socketPath));
  });

  it.live("ping responds with agentId", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("sock-ping");
      const service = yield* connectService(reg.apiKey);
      service.startSocketServer();
      try {
        const result = (yield* Effect.promise(() => socketRequest("ping"))) as {
          ok: boolean;
          agentId: string;
        };
        expect(result.ok).toBe(true);
        expect(result.agentId).toBe(reg.agentId);
      } finally {
        service.close();
        yield* reg.client.close();
      }
    }),
  );

  it.live("status returns connection info", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("sock-status");
      const service = yield* connectService(reg.apiKey);
      service.startSocketServer();
      try {
        const result = (yield* Effect.promise(() =>
          socketRequest("status"),
        )) as {
          agentId: string;
          connected: boolean;
        };
        expect(result.agentId).toBe(reg.agentId);
        expect(result.connected).toBe(true);
      } finally {
        service.close();
        yield* reg.client.close();
      }
    }),
  );

  it.live("passthrough RPC works via socket", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("sock-rpc-a");
      const regB = yield* registerAgent("sock-rpc-b");
      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const conv = (yield* Effect.promise(() =>
          socketRequest("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regB.agentId }],
          }),
        )) as { conversation: { id: string } };
        expect(conv.conversation.id).toBeDefined();

        const msg = (yield* Effect.promise(() =>
          socketRequest("messages/send", {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "via socket" }],
          }),
        )) as { message: { id: string } };
        expect(msg.message.id).toBeDefined();
      } finally {
        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
      }
    }),
  );

  it.live("history via socket returns messages with isOwn labels", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("sock-hist-a");
      const regB = yield* registerAgent("sock-hist-b");
      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const conv = (yield* Effect.promise(() =>
          socketRequest("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regB.agentId }],
          }),
        )) as { conversation: { id: string } };

        yield* Effect.promise(() =>
          socketRequest("messages/send", {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "Hello from A" }],
          }),
        );
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
        yield* sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

        const result = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: conv.conversation.id,
            limit: 10,
          }),
        )) as {
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
        yield* regA.client.close();
        yield* regB.client.close();
      }
    }),
  );

  it.live(
    "messages stay *NEW* after getContext notification until history is read",
    () =>
      Effect.gen(function* () {
        const regA = yield* registerAgent("wm-a");
        const regB = yield* registerAgent("wm-b");
        const regC = yield* registerAgent("wm-c");
        yield* regB.client.connect(regB.apiKey);
        yield* regC.client.connect(regC.apiKey);
        const service = yield* connectService(regA.apiKey);
        service.startSocketServer();
        try {
          const convB = (yield* service.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regB.agentId }],
          })) as { conversation: { id: string } };
          const convC = (yield* service.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regC.agentId }],
          })) as { conversation: { id: string } };

          // Seller sends message in conv C
          yield* sendAndSettle(
            regC.client,
            convC.conversation.id,
            "Price is $4000",
          );

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
          const hist1 = (yield* Effect.promise(() =>
            socketRequest("history", {
              conversationId: convC.conversation.id,
              sessionKey: convB.conversation.id,
              limit: 10,
            }),
          )) as {
            newCount: number;
            messages: Array<{ isNew: boolean; text: string }>;
          };
          expect(hist1.newCount).toBe(1);
          expect(hist1.messages[0]!.isNew).toBe(true);
          expect(hist1.messages[0]!.text).toBe("Price is $4000");

          // After reading, lastRead advances → second fetch shows 0 new
          const hist2 = (yield* Effect.promise(() =>
            socketRequest("history", {
              conversationId: convC.conversation.id,
              sessionKey: convB.conversation.id,
              limit: 10,
            }),
          )) as { newCount: number };
          expect(hist2.newCount).toBe(0);
        } finally {
          service.close();
          yield* regA.client.close();
          yield* regB.client.close();
          yield* regC.client.close();
        }
      }),
  );

  it.live("new messages after history read are marked *NEW*", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("wm2-a");
      const regB = yield* registerAgent("wm2-b");
      const regC = yield* registerAgent("wm2-c");
      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const convB = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };
        const convC = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regC.agentId }],
        })) as { conversation: { id: string } };

        // First message
        yield* sendAndSettle(regC.client, convC.conversation.id, "First");
        service.getContext(convB.conversation.id, {
          type: "cross-conversation",
        });

        // Read history → advances lastRead
        const hist1 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convB.conversation.id,
            limit: 10,
          }),
        )) as { newCount: number };
        expect(hist1.newCount).toBe(1); // first read: 1 new

        // Second read → 0 new (already read)
        const hist2 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convB.conversation.id,
            limit: 10,
          }),
        )) as { newCount: number };
        expect(hist2.newCount).toBe(0);

        // New message arrives AFTER read
        yield* sendAndSettle(regC.client, convC.conversation.id, "Second");

        // Third read → 1 new (the new message)
        const hist3 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convB.conversation.id,
            limit: 10,
          }),
        )) as {
          newCount: number;
          messages: Array<{ isNew: boolean; text: string }>;
        };
        expect(hist3.newCount).toBe(1);
        const newMsgs = hist3.messages.filter((m) => m.isNew);
        expect(newMsgs[0]!.text).toBe("Second");
      } finally {
        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
        yield* regC.client.close();
      }
    }),
  );

  it.live("different sessions have independent read markers", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("wm3-a");
      const regB = yield* registerAgent("wm3-b");
      const regC = yield* registerAgent("wm3-c");
      const regD = yield* registerAgent("wm3-d");
      yield* regB.client.connect(regB.apiKey);
      yield* regC.client.connect(regC.apiKey);
      yield* regD.client.connect(regD.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const convB = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regB.agentId }],
        })) as { conversation: { id: string } };
        const convC = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regC.agentId }],
        })) as { conversation: { id: string } };
        const convD = (yield* service.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: regD.agentId }],
        })) as { conversation: { id: string } };

        // Message in conv C
        yield* sendAndSettle(
          regC.client,
          convC.conversation.id,
          "Shared update",
        );

        // Conv B reads history → advances lastRead for convB→convC
        const histB = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convB.conversation.id,
            limit: 10,
          }),
        )) as { newCount: number };
        expect(histB.newCount).toBe(1); // first read

        // Conv B reads again → 0 new
        const histB2 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convB.conversation.id,
            limit: 10,
          }),
        )) as { newCount: number };
        expect(histB2.newCount).toBe(0);

        // Conv D reads same conversation → still 1 new (independent markers)
        const histD = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: convC.conversation.id,
            sessionKey: convD.conversation.id,
            limit: 10,
          }),
        )) as { newCount: number };
        expect(histD.newCount).toBe(1);
      } finally {
        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
        yield* regC.client.close();
        yield* regD.client.close();
      }
    }),
  );

  it.live(
    "socket request resolves without 10s hang (timer leak regression)",
    () =>
      Effect.gen(function* () {
        const reg = yield* registerAgent("sock-timer");
        const service = yield* connectService(reg.apiKey);
        service.startSocketServer();
        try {
          const start = performance.now();
          yield* Effect.promise(() => socketRequest("ping"));
          const elapsed = performance.now() - start;
          expect(elapsed).toBeLessThan(2000);
        } finally {
          service.close();
          yield* reg.client.close();
        }
      }),
  );

  it.live("two services use separate socket paths", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("sock-multi-a");
      const regB = yield* registerAgent("sock-multi-b");
      const serviceA = yield* connectService(regA.apiKey);
      const serviceB = yield* connectService(regB.apiKey);
      serviceA.startSocketServer();
      serviceB.startSocketServer();
      try {
        expect(serviceA.socketPath).not.toBe(serviceB.socketPath);

        // Both respond via their own socket path
        const resultA = (yield* Effect.promise(() =>
          socketRequest("ping", undefined, serviceA.socketPath),
        )) as { agentId: string };
        const resultB = (yield* Effect.promise(() =>
          socketRequest("ping", undefined, serviceB.socketPath),
        )) as { agentId: string };
        expect(resultA.agentId).toBe(regA.agentId);
        expect(resultB.agentId).toBe(regB.agentId);
      } finally {
        serviceA.close();
        serviceB.close();
        yield* regA.client.close();
        yield* regB.client.close();
      }
    }),
  );

  it.live("lastRead tracks seen message IDs across reads", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("sock-page-a");
      const regB = yield* registerAgent("sock-page-b");
      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const conv = (yield* Effect.promise(() =>
          socketRequest("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regB.agentId }],
          }),
        )) as { conversation: { id: string } };

        // Send 3 messages from B
        for (let i = 0; i < 3; i++) {
          yield* sendAndSettle(
            regB.client,
            conv.conversation.id,
            `track-msg-${i}`,
          );
        }

        // First read marks all 3 as seen
        const hist1 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: conv.conversation.id,
            sessionKey: "track-test-session",
            limit: 10,
          }),
        )) as {
          newCount: number;
          messages: Array<{ isNew: boolean; text: string }>;
        };
        expect(hist1.messages.length).toBe(3);

        // New message arrives after read
        yield* sendAndSettle(
          regB.client,
          conv.conversation.id,
          "track-msg-new",
        );

        // Read again — only the new message should be marked new
        const hist2 = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: conv.conversation.id,
            sessionKey: "track-test-session",
            limit: 10,
          }),
        )) as {
          newCount: number;
          messages: Array<{ isNew: boolean; text: string }>;
        };
        expect(hist2.newCount).toBe(1);
        const newMsg = hist2.messages.find((m) => m.isNew);
        expect(newMsg?.text).toBe("track-msg-new");
      } finally {
        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
      }
    }),
  );

  it.live("non-text message parts render as markers in socket history", () =>
    Effect.gen(function* () {
      const regA = yield* registerAgent("sock-attach-a");
      const regB = yield* registerAgent("sock-attach-b");
      yield* regB.client.connect(regB.apiKey);
      const service = yield* connectService(regA.apiKey);
      service.startSocketServer();
      try {
        const conv = (yield* Effect.promise(() =>
          socketRequest("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: regB.agentId }],
          }),
        )) as { conversation: { id: string } };

        yield* regB.client.rpc("messages/send", {
          conversationId: conv.conversation.id,
          parts: [
            { type: "text", text: "Check this out" },
            { type: "image", url: "https://example.com/photo.jpg" },
          ],
        });
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

        const result = (yield* Effect.promise(() =>
          socketRequest("history", {
            conversationId: conv.conversation.id,
            limit: 10,
          }),
        )) as { messages: Array<{ text: string }> };

        const msg = result.messages.find((m) =>
          m.text.includes("Check this out"),
        );
        expect(msg).toBeDefined();
        expect(msg!.text).toContain("[image]");
      } finally {
        service.close();
        yield* regA.client.close();
        yield* regB.client.close();
      }
    }),
  );

  it.live(
    "socketPath is stable after connect (cached at startSocketServer time)",
    () =>
      Effect.gen(function* () {
        const reg = yield* registerAgent("sock-stable");
        const service = yield* connectService(reg.apiKey);
        service.startSocketServer();
        const pathAtStart = service.socketPath;
        try {
          const result = (yield* Effect.promise(() =>
            socketRequest("ping", undefined, pathAtStart),
          )) as {
            ok: boolean;
          };
          expect(result.ok).toBe(true);
        } finally {
          service.close();
          yield* reg.client.close();
        }
      }),
  );

  it.live("unknown socket method rejects with error", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("sock-unknown");
      const service = yield* connectService(reg.apiKey);
      service.startSocketServer();
      try {
        const result = yield* Effect.either(
          Effect.tryPromise(() =>
            socketRequest("nonexistent/method", { foo: "bar" }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
      } finally {
        service.close();
        yield* reg.client.close();
      }
    }),
  );

  it.live("history rejects when conversationId is missing or wrong type", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent("sock-validate");
      const service = yield* connectService(reg.apiKey);
      service.startSocketServer();
      // `catch: (e) => e as Error` keeps the original rejection message
      // rather than wrapping it in UnknownException.
      const tryReq = (params: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => socketRequest("history", params),
          catch: (e) => e as Error,
        });
      try {
        const r1 = yield* Effect.either(tryReq({}));
        expect(Either.isLeft(r1)).toBe(true);
        if (Either.isLeft(r1)) {
          expect(r1.left.message).toContain("conversationId is required");
        }
        const r2 = yield* Effect.either(tryReq({ conversationId: 123 }));
        expect(Either.isLeft(r2)).toBe(true);
        if (Either.isLeft(r2)) {
          expect(r2.left.message).toContain("conversationId is required");
        }
        const r3 = yield* Effect.either(
          tryReq({ conversationId: "abc", limit: "not-a-number" }),
        );
        expect(Either.isLeft(r3)).toBe(true);
        if (Either.isLeft(r3)) {
          expect(r3.left.message).toContain("limit must be a number");
        }
      } finally {
        service.close();
        yield* reg.client.close();
      }
    }),
  );
});
