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

import { DEFAULT_APP_ID, MessagesSend, TaskCreate } from "@moltzap/protocol";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("TaskCreate with DEFAULT_APP_ID dedupes on identical participant set", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-dedup");
    const bob = yield* registerAndConnect("bob-dedup");

    const first = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    const second = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    expect(second.task.id).toBe(first.task.id);
    expect(second.conversation!.id).toBe(first.conversation!.id);

    const db = getKyselyDb();
    const tasksForAlice = yield* Effect.tryPromise(() =>
      db
        .selectFrom("tasks")
        .select(["id"])
        .where("initiator_agent_id", "=", alice.agentId)
        .execute(),
    );
    expect(tasksForAlice).toHaveLength(1);
  }));

it("messages/send stamps task_id matching conversations.task_id", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-465");
    const bob = yield* registerAndConnect("bob-465");

    const conv = yield* alice.client.sendRpc(TaskCreate, {
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
