import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "./service.integration-support.js";

H.setupServiceIntegration();

// ─── Group 1: Connection & Core API ──────────────────────────────────────────

it("connect() returns HelloOk with agentId", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("svc-agent");
    const service = yield* H.connectService(reg.apiKey);

    expect(service.ownAgentId).toBe(reg.agentId);
    expect(service.connected).toBe(true);

    service.close();
    yield* reg.client.close();
  }));

it("conversations/list returns existing conversations after connect", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("agent-a");
    const regB = yield* H.registerAgent("agent-b");

    // Connect agent-a and create a conversation before agent-b connects as service
    yield* regA.client.connect();
    const conv = yield* regA.client.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });

    // Phase 12: HelloOk no longer carries task-layer state (no eager
    // conversations payload). The service cache populates from
    // notifications going forward; existing conversations are fetched
    // explicitly via `conversations/list`.
    const service = yield* H.connectService(regB.apiKey);
    expect(service.getConversation(conv.conversation.id)).toBeUndefined();

    const list = (yield* service.sendRpc(H.ConversationsList, {})) as {
      conversations: Array<{ id: string; type: string }>;
    };
    const found = list.conversations.find((c) => c.id === conv.conversation.id);
    expect(found).toBeDefined();
    expect(found!.type).toBe("dm");

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("on('message') fires for incoming message from another agent", () =>
  Effect.gen(function* () {
    const regSender = yield* H.registerAgent("sender");
    const regReceiver = yield* H.registerAgent("receiver");

    yield* regSender.client.connect();
    const service = yield* H.connectService(regReceiver.apiKey);

    const conv = yield* regSender.client.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regReceiver.agentId }],
    });

    const received: unknown[] = [];
    service.on("message", (msg) => received.push(msg));

    yield* H.sendAndSettle(
      regSender.client,
      conv.conversation.id,
      H.HELLO_RECEIVER,
    );

    expect(received.length).toBe(1);
    const msg = received[0] as { parts: Array<{ text: string }> };
    expect(msg.parts[0]!.text).toBe(H.HELLO_RECEIVER);

    service.close();
    yield* regSender.client.close();
    yield* regReceiver.client.close();
  }));
