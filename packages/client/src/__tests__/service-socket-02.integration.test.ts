import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "./service.integration-support.js";

H.setupServiceIntegration();

// ─── Group 4: Socket Server ──────────────────────────────────────────────────

it("history via socket returns messages with isOwn labels", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-hist-a");
    const regB = yield* H.registerAgent(H.SOCK_HIST_B_NAME);
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const conv = yield* H.socketRpcRequest(H.ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      });

      yield* H.socketRpcRequest(H.MessagesSend, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Hello from A" }],
      });
      yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);
      yield* H.sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

      const result = yield* H.socketHistory(conv.conversation.id);

      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      const ownMsgs = result.messages.filter((m) => m.isOwn);
      expect(ownMsgs.length).toBeGreaterThanOrEqual(1);
      expect(ownMsgs[0]!.senderName).toBe("you");
      const otherMsgs = result.messages.filter((m) => !m.isOwn);
      expect(otherMsgs.length).toBeGreaterThanOrEqual(1);
      expect(otherMsgs[0]!.senderName).toBe(H.SOCK_HIST_B_NAME);
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));

it("messages stay *NEW* after getContext notification until history is read", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm-a");
    const regB = yield* H.registerAgent("wm-b");
    const regC = yield* H.registerAgent("wm-c");
    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const convB = yield* service.sendRpc(H.ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: regB.agentId }],
      });
      const convC = yield* service.sendRpc(H.ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: regC.agentId }],
      });

      // Seller sends message in conv C
      yield* H.sendAndSettle(
        regC.client,
        convC.conversation.id,
        H.PRICE_MESSAGE,
      );

      // System-reminder fires for conv B → advances lastNotified
      const reminder = service.getContext(convB.conversation.id, {
        type: "cross-conversation",
      });
      expect(reminder).toContain(H.ONE_NEW_MARKER);

      // System-reminder won't repeat (lastNotified advanced)
      const reminder2 = service.getContext(convB.conversation.id, {
        type: "cross-conversation",
      });
      expect(reminder2).toBeNull();

      // BUT history via socket still shows *NEW* (lastRead not advanced yet)
      const hist1 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist1.newCount).toBe(1);
      expect(hist1.messages[0]!.isNew).toBe(true);
      expect(hist1.messages[0]!.text).toBe(H.PRICE_MESSAGE);

      // After reading, lastRead advances → second fetch shows 0 new
      const hist2 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist2.newCount).toBe(0);
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
      yield* regC.client.close();
    }
  }));

it("new messages after history read are marked *NEW*", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm2-a");
    const regB = yield* H.registerAgent("wm2-b");
    const regC = yield* H.registerAgent("wm2-c");
    yield* H.connectClients(regB.client, regC.client);
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const convB = yield* H.createDm(service, regB.agentId);
      const convC = yield* H.createDm(service, regC.agentId);

      // First message
      yield* H.sendAndSettle(
        regC.client,
        convC.conversation.id,
        H.FIRST_MESSAGE,
      );
      service.getContext(convB.conversation.id, {
        type: "cross-conversation",
      });

      // Read history → advances lastRead
      const hist1 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist1.newCount).toBe(1); // first read: 1 new

      // Second read → 0 new (already read)
      const hist2 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist2.newCount).toBe(0);

      // New message arrives AFTER read
      yield* H.sendAndSettle(
        regC.client,
        convC.conversation.id,
        H.SECOND_MESSAGE,
      );

      // Third read → 1 new (the new message)
      const hist3 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist3.newCount).toBe(1);
      const newMsgs = hist3.messages.filter((m) => m.isNew);
      expect(newMsgs[0]!.text).toBe(H.SECOND_MESSAGE);
    } finally {
      service.close();
      yield* H.closeClients(regA.client, regB.client, regC.client);
    }
  }));
