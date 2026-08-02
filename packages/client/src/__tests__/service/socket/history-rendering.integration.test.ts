import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

type HistoryMessage = H.SocketHistoryResponse["messages"][number];
const isNew = (m: HistoryMessage) => m.isNew;
const containsAttachmentCaption = (m: HistoryMessage) =>
  m.text.includes("Check this out");

it("lastRead tracks seen message IDs across reads", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-page-a");
    const regB = yield* H.registerAgent("sock-page-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    // Cleanup must be Effect.ensuring: a gen-body finally is skipped when a yielded effect fails.
    yield* Effect.gen(function* () {
      const conv = yield* service.call(H.agentConversationCreate.name, {
        participants: [regB.agentId],
      });

      // Send 3 messages from B
      for (let i = 0; i < 3; i++) {
        yield* H.sendAndSettle(
          regB.client,
          conv.conversation.id,
          `track-msg-${i}`,
        );
      }

      // First read marks all 3 as seen
      const hist1 = yield* H.socketHistory(
        conv.conversation.id,
        H.TRACK_SESSION_KEY,
      );
      expect(hist1.messages.length).toBe(H.SOCKET_PAGE_MESSAGE_COUNT);

      // New message arrives after read
      yield* H.sendAndSettle(
        regB.client,
        conv.conversation.id,
        H.TRACK_NEW_MESSAGE,
      );

      // Read again — only the new message should be marked new
      const hist2 = yield* H.socketHistory(
        conv.conversation.id,
        H.TRACK_SESSION_KEY,
      );
      expect(hist2.newCount).toBe(1);
      const newMsg = hist2.messages.find(isNew);
      expect(newMsg?.text).toBe(H.TRACK_NEW_MESSAGE);
    }).pipe(Effect.ensuring(H.closeAll([service], [regA.client, regB.client])));
  }));

it("non-text message parts render as markers in socket history", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-attach-a");
    const regB = yield* H.registerAgent("sock-attach-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    yield* Effect.gen(function* () {
      const conv = yield* service.call(H.agentConversationCreate.name, {
        participants: [regB.agentId],
      });

      yield* regB.client.call(H.messagesSend.name, {
        conversationId: conv.conversation.id,
        parts: [
          { type: "text", text: "Check this out" },
          { type: "image", url: "https://example.com/photo.jpg" },
        ],
      });
      yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);

      const result = yield* H.socketHistory(conv.conversation.id);

      const msg = result.messages.find(containsAttachmentCaption);
      expect(msg).toBeDefined();
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ msg!
          .text,
      ).toContain(H.IMAGE_MARKER);
    }).pipe(Effect.ensuring(H.closeAll([service], [regA.client, regB.client])));
  }));

it("socketPath is stable after connect (cached at startSocketServer time)", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-stable");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    const pathAtStart = service.socketPath;
    yield* Effect.gen(function* () {
      const result = yield* H.requestDaemonCommand(
        H.localDaemonCommands.status,
        {},
        pathAtStart,
      );
      expect(result.agentId).toBe(reg.agentId);
    }).pipe(Effect.ensuring(H.closeAll([service], [reg.client])));
  }));
