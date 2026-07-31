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

import { DEFAULT_APP_ID } from "@moltzap/protocol/identity";
import { agentConversationCreate } from "@moltzap/protocol/conversation";
import { messagesList, messagesSend } from "@moltzap/protocol/message";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("send and receive a DM, list messages", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-dm");
    const bob = yield* registerAndConnect("bob-dm");

    // Alice creates a DM conversation with Bob
    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      appId: DEFAULT_APP_ID,
      participants: [bob.agentId],
    });

    const conversationId = conv.conversation.id;

    // Alice sends a message
    const sendResult = yield* alice.client.sendRpc(messagesSend, {
      conversationId,
      parts: [{ type: "text", text: "Hello Bob!" }],
    });

    expect(sendResult.message.id).toBeDefined();
    expect(sendResult.message.parts).toEqual([
      { type: "text", text: "Hello Bob!" },
    ]);

    // Alice lists messages
    const messages = yield* alice.client.sendRpc(messagesList, {
      conversationId,
    });

    expect(messages.messages).toHaveLength(1);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ messages
        .messages[0]!.id,
    ).toBe(sendResult.message.id);

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
