import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
  type ConnectedAgent,
} from "../helpers.js";
import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";

const it = effectIt.live;

const AES_GCM_IV_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;
const CONV_TYPE_GROUP = "group";
const PARTICIPANT_TYPE_AGENT = "agent";
const PART_TYPE_TEXT = "text";
const ENCRYPTION_CONVERSATION_NAME = "Enc Test";
const ENCRYPTED_MESSAGE_TEXT = "This should be encrypted";

beforeAll(() => Effect.runPromise(startTestServerEffect({ encryption: true })));
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function createEncryptedConversation(agent: ConnectedAgent) {
  return agent.client.sendRpc(ConversationsCreate, {
    type: CONV_TYPE_GROUP,
    name: ENCRYPTION_CONVERSATION_NAME,
    participants: [{ type: PARTICIPANT_TYPE_AGENT, id: agent.agentId }],
  }) as Effect.Effect<{ conversation: { id: string } }, unknown>;
}

function sendEncryptedProbe(agent: ConnectedAgent, conversationId: string) {
  return agent.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: PART_TYPE_TEXT, text: ENCRYPTED_MESSAGE_TEXT }],
  }) as Effect.Effect<{ message: { id: string } }, unknown>;
}

function readMessageCryptoRow(messageId: string) {
  const db = getKyselyDb();
  return Effect.tryPromise(() =>
    db
      .selectFrom("messages")
      .select([
        "parts_encrypted",
        "parts_iv",
        "parts_tag",
        "dek_version",
        "kek_version",
      ])
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow(),
  );
}

function readConversationKeyRows(conversationId: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("conversation_keys")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .execute(),
  );
}

function readMessageTexts(agent: ConnectedAgent, conversationId: string) {
  return agent.client.sendRpc(MessagesList, { conversationId }).pipe(
    Effect.map(
      (result) =>
        (result as { messages: Array<{ parts: Array<{ text: string }> }> })
          .messages,
    ),
    Effect.map((messages) => messages.map((message) => message.parts[0]!.text)),
  );
}

function messagePartsAreEncryptedInDb() {
  return Effect.gen(function* () {
    const agent = yield* registerAndConnect("enc-agent");
    const conv = yield* createEncryptedConversation(agent);
    const conversationId = conv.conversation.id;
    const msg = yield* sendEncryptedProbe(agent, conversationId);
    const row = yield* readMessageCryptoRow(msg.message.id);

    const encrypted = row.parts_encrypted as Buffer;
    const iv = row.parts_iv as Buffer;
    const tag = row.parts_tag as Buffer;

    expect(iv.length).toBe(AES_GCM_IV_BYTES);
    expect(tag.length).toBe(AES_GCM_AUTH_TAG_BYTES);
    expect(row.dek_version).toBeGreaterThanOrEqual(1);
    expect(row.kek_version).toBeGreaterThanOrEqual(1);
    expect(encrypted.toString("utf-8")).not.toContain(ENCRYPTED_MESSAGE_TEXT);
    expect(yield* readMessageTexts(agent, conversationId)).toEqual([
      ENCRYPTED_MESSAGE_TEXT,
    ]);
    expect(
      (yield* readConversationKeyRows(conversationId)).length,
    ).toBeGreaterThanOrEqual(1);
    yield* agent.client.close();
  });
}

describe("Scenario 7: Encryption", () => {
  it(
    "message parts are encrypted in DB, IV and tag have correct lengths",
    messagePartsAreEncryptedInDb,
  );
});
