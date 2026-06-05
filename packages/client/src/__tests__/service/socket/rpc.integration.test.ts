import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol";
import { Effect, Either } from "effect";
import * as H from "../../support/index.js";
import {
  conversationId as makeConversationId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";

const TASK_NOT_FOUND_TAG = "TaskNotFound";

H.setupServiceIntegration();

it("status returns connection info", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-status");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    try {
      const result = yield* H.requestDaemonCommand(
        H.LocalDaemonCommands.Status,
        {},
      );
      expect(result.agentId).toBe(reg.agentId);
      expect(result.connected).toBe(true);
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));

it("send command works via socket", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-rpc-a");
    const regB = yield* H.registerAgent("sock-rpc-b");
    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    try {
      const conv = yield* service.call(TaskRequest.name, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [regB.agentId],
        initialConversation: { participants: [regB.agentId] },
      });
      expect(conv.conversation!.id).toBeDefined();

      const msg = yield* H.requestDaemonCommand(H.LocalDaemonCommands.Send, {
        target: {
          taskId: conv.task.id,
          conversationId: conv.conversation!.id,
        },
        message: "via socket",
      });
      expect(msg.messageId).toBeDefined();
    } finally {
      service.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));

it("command preserves protocol error tag over socket", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-rpc-error");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    try {
      const result = yield* Effect.either(
        H.requestDaemonCommand(H.LocalDaemonCommands.MessagesList, {
          taskId: makeTaskId("00000000-0000-4000-8000-00000000f001"),
          conversationId: makeConversationId(
            "00000000-0000-4000-8000-00000000f002",
          ),
        }),
      );
      Either.match(result, {
        onLeft: (error) => expect(error._tag).toBe(TASK_NOT_FOUND_TAG),
        onRight: () => expect.fail(),
      });
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));
