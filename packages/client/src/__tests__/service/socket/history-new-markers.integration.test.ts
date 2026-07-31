import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

type HistoryMessage = H.SocketHistoryResponse["messages"][number];
const isOwn = (m: HistoryMessage) => m.isOwn;
const isNotOwn = (m: HistoryMessage) => !m.isOwn;

it("history via socket returns messages with isOwn labels", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-hist-a");
    const regB = yield* H.registerAgent(H.SOCK_HIST_B_NAME);
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    // Cleanup must be Effect.ensuring: a gen-body finally is skipped when a yielded effect fails.
    yield* Effect.gen(function* () {
      const conv = yield* service.call(H.agentConversationCreate.name, {
        appId: H.DEFAULT_APP_ID,
        participants: [regB.agentId],
      });

      yield* service.call(H.messagesSend.name, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Hello from A" }],
      });
      yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);
      yield* H.sendAndSettle(regB.client, conv.conversation.id, "Hello from B");

      const result = yield* H.socketHistory(conv.conversation.id);

      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      const ownMsgs = result.messages.filter(isOwn);
      expect(ownMsgs.length).toBeGreaterThanOrEqual(1);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ ownMsgs[0]!
          .senderName,
      ).toBe("you");
      const otherMsgs = result.messages.filter(isNotOwn);
      expect(otherMsgs.length).toBeGreaterThanOrEqual(1);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ otherMsgs[0]!
          .senderName,
      ).toBe(H.SOCK_HIST_B_NAME);
    }).pipe(Effect.ensuring(H.closeAll([service], [regA.client, regB.client])));
  }));

it("messages stay *NEW* after getContext notification until history is read", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm-a");
    const regB = yield* H.registerAgent("wm-b");
    const regC = yield* H.registerAgent("wm-c");
    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();

    yield* Effect.gen(function* () {
      const convB = yield* H.createDm(service, regB.agentId);
      const convC = yield* H.createDm(service, regC.agentId);

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
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ hist1
          .messages[0]!.isNew,
      ).toBe(true);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ hist1
          .messages[0]!.text,
      ).toBe(H.PRICE_MESSAGE);

      // After reading, lastRead advances → second fetch shows 0 new
      const hist2 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(hist2.newCount).toBe(0);
    }).pipe(
      Effect.ensuring(
        H.closeAll([service], [regA.client, regB.client, regC.client]),
      ),
    );
  }));

it("new messages after history read are marked *NEW*", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm2-a");
    const regB = yield* H.registerAgent("wm2-b");
    const regC = yield* H.registerAgent("wm2-c");
    yield* H.connectClients(regB.client, regC.client);
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    yield* Effect.gen(function* () {
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

      const readC = () =>
        H.socketHistory(convC.conversation.id, convB.conversation.id);

      // Read history → advances lastRead
      const hist1 = yield* readC();
      expect(hist1.newCount).toBe(1); // first read: 1 new
      // Second read → 0 new (already read)
      const hist2 = yield* readC();
      expect(hist2.newCount).toBe(0);
      // New message arrives AFTER read
      yield* H.sendAndSettle(
        regC.client,
        convC.conversation.id,
        H.SECOND_MESSAGE,
      );
      // Third read → 1 new (the new message)
      const hist3 = yield* readC();
      expect(hist3.newCount).toBe(1);
      const newMsgs = hist3.messages.filter((m) => m.isNew);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ newMsgs[0]!
          .text,
      ).toBe(H.SECOND_MESSAGE);
    }).pipe(
      Effect.ensuring(
        H.closeAll([service], [regA.client, regB.client, regC.client]),
      ),
    );
  }));
