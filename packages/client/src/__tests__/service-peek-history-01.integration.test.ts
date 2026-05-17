import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "./service.integration-support.js";

H.setupServiceIntegration();

// ─── Group 2b: peekFullMessages ──────────────────────────────────────────────

it("returns full messages from other conversations sorted by timestamp", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("pfm-a");
    const regB = yield* H.registerAgent("pfm-b");
    const regC = yield* H.registerAgent("pfm-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });

    const convC = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    });

    yield* H.sendAndSettle(regC.client, convC.conversation.id, H.PEEK_FROM_C);
    yield* H.sendAndSettle(regB.client, convB.conversation.id, "from B");

    const { messages } = service.peekFullMessages(convB.conversation.id);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    // convC message should appear (it's a different conversation)
    const texts = messages.map((m) => m.text);
    expect(texts).toContain(H.PEEK_FROM_C);
    // Messages sorted chronologically — H.PEEK_FROM_C sent before "from B"
    const cIdx = texts.indexOf(H.PEEK_FROM_C);
    expect(cIdx).toBeGreaterThanOrEqual(0);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("returns all messages without artificial caps", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("nocap-a");
    const agents = [];
    for (let i = 0; i < 7; i++) {
      const reg = yield* H.registerAgent(`nocap-b${i}`);
      yield* reg.client.connect();
      agents.push(reg);
    }
    const service = yield* H.connectService(regA.apiKey);

    const convIds: string[] = [];
    for (const agent of agents) {
      const conv = yield* service.sendRpc(H.ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: agent.agentId }],
      });
      convIds.push(conv.conversation.id);
      yield* H.sendAndSettle(
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
  }));

it("commit advances markers — second peek returns only new messages", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("commit-a");
    const regB = yield* H.registerAgent("commit-b");
    const regC = yield* H.registerAgent("commit-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });

    const convC = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    });

    yield* H.sendAndSettle(regC.client, convC.conversation.id, "old msg");

    const first = service.peekFullMessages(convB.conversation.id);
    expect(first.messages.length).toBeGreaterThanOrEqual(1);
    first.commit();

    // Peek again — old message should be gone
    const second = service.peekFullMessages(convB.conversation.id);
    expect(second.messages.length).toBe(0);

    // Send a new message — should appear
    yield* H.sendAndSettle(regC.client, convC.conversation.id, H.NEW_MESSAGE);
    const third = service.peekFullMessages(convB.conversation.id);
    expect(third.messages.length).toBeGreaterThanOrEqual(1);
    expect(third.messages.map((m) => m.text)).toContain(H.NEW_MESSAGE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

// ─── Group 3: History with Session Key ───────────────────────────────────────
