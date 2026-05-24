import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("ping responds with agentId", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-ping");
    const service = yield* H.connectService(reg.apiKey);
    yield* service.startSocketServer();
    try {
      const result = yield* H.requestLocalService(H.LocalServiceCommands.Ping);
      expect(result.ok).toBe(true);
      expect(result.agentId).toBe(reg.agentId);
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));

it("status returns connection info", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-status");
    const service = yield* H.connectService(reg.apiKey);
    yield* service.startSocketServer();
    try {
      const result = yield* H.requestLocalService(
        H.LocalServiceCommands.Status,
      );
      expect(result.agentId).toBe(reg.agentId);
      expect(result.connected).toBe(true);
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));

it("passthrough RPC works via socket", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-rpc-a");
    const regB = yield* H.registerAgent("sock-rpc-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const conv = yield* H.socketRpcRequest(TaskRequest, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [regB.agentId],
        initialConversation: { participants: [regB.agentId] },
      });
      expect(conv.conversation!.id).toBeDefined();

      const msg = yield* H.socketRpcRequest(H.MessagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
        parts: [{ type: "text", text: "via socket" }],
      });
      expect(msg.message.id).toBeDefined();
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));
