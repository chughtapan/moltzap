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

import {
  DEFAULT_APP_ID,
  MessagesList,
  MessagesSend,
  TaskCreate,
} from "@moltzap/protocol";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      _baseUrl = server.baseUrl;
      _wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("send and receive a DM, list messages", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-dm");
    const bob = yield* registerAndConnect("bob-dm");

    // Alice creates a DM conversation with Bob
    const conv = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });

    expect(conv.conversation!.type).toBe("dm");
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    // Alice sends a message
    const sendResult = yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: "Hello Bob!" }],
    });

    expect(sendResult.message.id).toBeDefined();
    expect(sendResult.message.parts).toEqual([
      { type: "text", text: "Hello Bob!" },
    ]);

    // Alice lists messages
    const messages = yield* alice.client.sendRpc(MessagesList, {
      taskId,
      conversationId,
    });

    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.id).toBe(sendResult.message.id);

    // Verify message is encrypted in DB
    const db = getKyselyDb();
    const dbRow = yield* Effect.tryPromise(() =>
      db
        .selectFrom("messages")
        .select(["parts_encrypted", "parts_iv", "parts_tag"])
        .where("id", "=", sendResult.message.id)
        .executeTakeFirstOrThrow(),
    );

    expect(dbRow.parts_iv).toBeDefined();
    expect(dbRow.parts_tag).toBeDefined();

    yield* alice.client.close();
    yield* bob.client.close();
  }));
