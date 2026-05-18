import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Data, Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
  getEncryptionEnvelope,
  type ConnectedAgent,
} from "../helpers.js";
import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";
import { rotateKek } from "../../../crypto/key-rotation.js";

const it = effectIt.live;

const AES_GCM_IV_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;
const CONV_TYPE_GROUP = "group";
const PARTICIPANT_TYPE_AGENT = "agent";
const PART_TYPE_TEXT = "text";
const ENCRYPTION_CONVERSATION_NAME = "Enc Test";
const ENCRYPTED_MESSAGE_TEXT = "This should be encrypted";
const POST_ROTATION_MESSAGE_TEXT = "This should still decrypt after rotation";
const INITIAL_KEK_VERSION = 1;
const ROTATED_KEK_VERSION = 2;
const ACTIVE_KEY_STATUS = "active";

class KekRotationTestError extends Data.TaggedError("KekRotationTestError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface ConversationKeySnapshot {
  readonly dek_version: number;
  readonly kek_version: number;
  readonly wrapped_dek: string;
}

interface EncryptionKeySnapshot {
  readonly version: number;
  readonly status: string;
}

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

function sendEncryptedProbe(
  agent: ConnectedAgent,
  conversationId: string,
  text = ENCRYPTED_MESSAGE_TEXT,
) {
  return agent.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: PART_TYPE_TEXT, text }],
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

function readEncryptionKeyRows() {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("encryption_keys")
      .select(["version", "status"])
      .orderBy("version", "asc")
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

function rotateLiveKek() {
  return Effect.tryPromise({
    try: () => rotateKek(getKyselyDb(), getEncryptionEnvelope()),
    catch: (cause) =>
      new KekRotationTestError({
        message: "KEK rotation failed during encryption integration test",
        cause,
      }),
  });
}

function assertInitialConversationKey(
  rows: ReadonlyArray<ConversationKeySnapshot>,
): ConversationKeySnapshot {
  expect(rows).toHaveLength(1);
  const row = rows[0]!;

  expect(row.dek_version).toBe(INITIAL_KEK_VERSION);
  expect(row.kek_version).toBe(INITIAL_KEK_VERSION);
  return row;
}

function assertRotatedConversationKey(
  rows: ReadonlyArray<ConversationKeySnapshot>,
  before: ConversationKeySnapshot,
) {
  expect(rows).toHaveLength(1);
  const row = rows[0]!;

  expect(row.dek_version).toBe(before.dek_version);
  expect(row.kek_version).toBe(ROTATED_KEK_VERSION);
  expect(row.wrapped_dek).not.toBe(before.wrapped_dek);
}

function assertEncryptionKeysRotated(
  rows: ReadonlyArray<EncryptionKeySnapshot>,
) {
  expect(rows).toHaveLength(1);
  expect(rows.map(({ version, status }) => ({ version, status }))).toEqual([
    { version: ROTATED_KEK_VERSION, status: ACTIVE_KEY_STATUS },
  ]);
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

function kekRotationRewrapsConversationKeysAndKeepsMessagesReadable() {
  return Effect.gen(function* () {
    const agent = yield* registerAndConnect("enc-rotation-agent");
    const conv = yield* createEncryptedConversation(agent);
    const conversationId = conv.conversation.id;
    const firstMessage = yield* sendEncryptedProbe(agent, conversationId);
    const keyRowBeforeRotation = assertInitialConversationKey(
      yield* readConversationKeyRows(conversationId),
    );

    const rotatedVersion = yield* rotateLiveKek();

    expect(rotatedVersion).toBe(ROTATED_KEK_VERSION);

    assertRotatedConversationKey(
      yield* readConversationKeyRows(conversationId),
      keyRowBeforeRotation,
    );
    assertEncryptionKeysRotated(yield* readEncryptionKeyRows());

    const firstMessageRowAfterRotation = yield* readMessageCryptoRow(
      firstMessage.message.id,
    );

    expect(firstMessageRowAfterRotation.kek_version).toBe(ROTATED_KEK_VERSION);
    expect(yield* readMessageTexts(agent, conversationId)).toEqual([
      ENCRYPTED_MESSAGE_TEXT,
    ]);

    const secondMessage = yield* sendEncryptedProbe(
      agent,
      conversationId,
      POST_ROTATION_MESSAGE_TEXT,
    );
    const secondMessageRow = yield* readMessageCryptoRow(
      secondMessage.message.id,
    );

    expect(secondMessageRow.kek_version).toBe(ROTATED_KEK_VERSION);
    expect(yield* readMessageTexts(agent, conversationId)).toEqual([
      ENCRYPTED_MESSAGE_TEXT,
      POST_ROTATION_MESSAGE_TEXT,
    ]);
    yield* agent.client.close();
  });
}

describe("Scenario 7: Encryption", () => {
  it(
    "message parts are encrypted in DB, IV and tag have correct lengths",
    messagePartsAreEncryptedInDb,
  );

  it(
    "KEK rotation re-wraps conversation keys without breaking message decrypt",
    kekRotationRewrapsConversationKeysAndKeepsMessagesReadable,
  );
});
