import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
} from "../helpers.js";

import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import { MessagesSend } from "@moltzap/protocol/message";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("messages/send stamps task_id matching conversations.task_id", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-465");
    const bob = yield* registerAndConnect("bob-465");

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    const sendResult = yield* alice.client.sendRpc(MessagesSend, {
      taskId: conv.task.id,
      conversationId: conv.conversation!.id,
      parts: [{ type: "text", text: "hello" }],
    });

    const db = getKyselyDb();
    const messageRow = yield* Effect.tryPromise(() =>
      db
        .selectFrom("messages")
        .select(["task_id"])
        .where("id", "=", sendResult.message.id)
        .executeTakeFirstOrThrow(),
    );
    const convRow = yield* Effect.tryPromise(() =>
      db
        .selectFrom("conversations")
        .select(["task_id"])
        .where("id", "=", conv.conversation!.id)
        .executeTakeFirstOrThrow(),
    );

    expect(messageRow.task_id).not.toBeNull();
    expect(messageRow.task_id).toBe(convRow.task_id);
  }));
