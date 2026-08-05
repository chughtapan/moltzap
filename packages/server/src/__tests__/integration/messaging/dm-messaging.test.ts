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

    // Verify the durable row carries the parts the sender submitted
    const db = getKyselyDb();
    const dbRow = yield* Effect.tryPromise(() =>
      db
        .selectFrom("messages")
        .select(["parts"])
        .where("id", "=", sendResult.message.id)
        .executeTakeFirstOrThrow(),
    );

    expect(dbRow.parts).toEqual([{ type: "text", text: "Hello Bob!" }]);

    yield* alice.client.close();
    yield* bob.client.close();
  }));
