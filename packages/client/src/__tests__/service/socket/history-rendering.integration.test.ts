import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("lastRead tracks seen message IDs across reads", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-page-a");
    const regB = yield* H.registerAgent("sock-page-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const conv = yield* H.socketRpcRequest(TaskRequest.name, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [regB.agentId],
        initialConversation: { participants: [regB.agentId] },
      });

      // Send 3 messages from B
      for (let i = 0; i < 3; i++) {
        yield* H.sendAndSettle(
          regB.client,
          conv.task.id,
          conv.conversation!.id,
          `track-msg-${i}`,
        );
      }

      // First read marks all 3 as seen
      const hist1 = yield* H.socketHistory(
        conv.task.id,
        conv.conversation!.id,
        H.TRACK_SESSION_KEY,
      );
      expect(hist1.messages.length).toBe(H.SOCKET_PAGE_MESSAGE_COUNT);

      // New message arrives after read
      yield* H.sendAndSettle(
        regB.client,
        conv.task.id,
        conv.conversation!.id,
        H.TRACK_NEW_MESSAGE,
      );

      // Read again — only the new message should be marked new
      const hist2 = yield* H.socketHistory(
        conv.task.id,
        conv.conversation!.id,
        H.TRACK_SESSION_KEY,
      );
      expect(hist2.newCount).toBe(1);
      const newMsg = hist2.messages.find((m) => m.isNew);
      expect(newMsg?.text).toBe(H.TRACK_NEW_MESSAGE);
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));

it("non-text message parts render as markers in socket history", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-attach-a");
    const regB = yield* H.registerAgent("sock-attach-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const conv = yield* H.socketRpcRequest(TaskRequest.name, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [regB.agentId],
        initialConversation: { participants: [regB.agentId] },
      });

      yield* regB.client.sendRpc(H.MessagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
        parts: [
          { type: "text", text: "Check this out" },
          { type: "image", url: "https://example.com/photo.jpg" },
        ],
      });
      yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);

      const result = yield* H.socketHistory(
        conv.task.id,
        conv.conversation!.id,
      );

      const msg = result.messages.find((m) =>
        m.text.includes("Check this out"),
      );
      expect(msg).toBeDefined();
      expect(msg!.text).toContain(H.IMAGE_MARKER);
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));

it("socketPath is stable after connect (cached at startSocketServer time)", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-stable");
    const service = yield* H.connectService(reg.apiKey);
    yield* service.startSocketServer();
    const pathAtStart = service.socketPath;
    try {
      const result = yield* H.requestLocalService(
        H.LocalServiceCommands.Ping,
        undefined,
        pathAtStart,
      );
      expect(result.ok).toBe(true);
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));
