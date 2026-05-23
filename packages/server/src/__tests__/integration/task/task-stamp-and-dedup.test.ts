import { expect, beforeAll, afterAll, beforeEach, it as vit } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
} from "../helpers.js";

import { DEFAULT_APP_ID, MessagesSend, TaskRequest } from "@moltzap/protocol";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

// Pre-#677 the server deduped DEFAULT_APP_ID TaskRequest by participant
// set. Server dedup retired; the "one DM per pair" UX moves to clients
// (list + filter + create-or-use). Re-add coverage in the SDK package.
vit.todo("client-side DEFAULT_APP_ID dedup — list + match");

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
