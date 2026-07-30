import type { Db } from "../client.js";
import type { ConversationKeyRow, Database } from "../database.js";
import type { Transaction } from "../kysely-vendor.js";
import type { EnvelopeEncryption, EncryptedPayload } from "./envelope.js";
import type { Kek } from "./kek.js";
import { serializePayload, deserializePayload } from "./serialization.js";
import { Data, Effect } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import { takeFirstOrElse, transaction } from "../effect-kysely-toolkit.js";

class KeyRotationError extends Data.TaggedError("KeyRotationError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

interface ActiveKek {
  readonly version: number;
  readonly key: Kek;
}

interface NextKek {
  readonly version: number;
  readonly key: Kek;
  readonly encrypted: EncryptedPayload;
}

interface ConversationKeyForRotation
  extends Pick<
    ConversationKeyRow,
    "conversation_id" | "dek_version" | "wrapped_dek"
  > {}

interface RewrapConversationKeyInput {
  readonly row: ConversationKeyForRotation;
  readonly current: ActiveKek;
  readonly next: NextKek;
}

/**
 * Executes the seed initial kek operation.
 * @param db Value supplied to the operation.
 * @param envelope Value supplied to the operation.
 * @returns The seed initial kek result.
 */
export function seedInitialKek(db: Db, envelope: EnvelopeEncryption) {
  return Effect.runPromise(seedInitialKekEffect(db, envelope));
}

/**
 * Executes the rotate kek operation.
 * @param db Value supplied to the operation.
 * @param envelope Value supplied to the operation.
 * @returns The rotate kek result.
 */
export function rotateKek(db: Db, envelope: EnvelopeEncryption) {
  return Effect.runPromise(rotateKekEffect(db, envelope));
}

function seedInitialKekEffect(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<void, SqlError> {
  return Effect.gen(function* () {
    const kek = envelope.generateKek();
    const encrypted = envelope.encryptKek(kek);
    const serialized = serializePayload(encrypted);

    yield* db
      .insertInto("encryption_keys")
      .values({
        version: 1,
        encrypted_key: serialized,
        status: "active",
      })
      .onConflict((oc) => oc.column("version").doNothing());

    yield* Effect.logInfo("Seeded initial KEK version 1");
  });
}

function rotateKekEffect(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<number, SqlError | KeyRotationError> {
  return Effect.gen(function* () {
    const current = yield* loadActiveKek(db, envelope);
    const next = createNextKek(envelope, current.version);
    const reWrappedCount = yield* rewrapConversationKeys(
      db,
      envelope,
      current,
      next,
    );

    yield* Effect.logInfo("KEK rotated").pipe(
      Effect.annotateLogs({
        oldVersion: current.version,
        newVersion: next.version,
        reWrappedCount,
      }),
    );
    return next.version;
  });
}

function loadActiveKek(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<ActiveKek, SqlError | KeyRotationError> {
  return takeFirstOrElse(
    db
      .selectFrom("encryption_keys")
      .select(["version", "encrypted_key"])
      .where("status", "=", "active")
      .orderBy("version", "desc")
      .limit(1),
    () => new KeyRotationError({ reason: "No active KEK found" }),
  ).pipe(
    Effect.map((row) => ({
      version: row.version,
      key: envelope.decryptKek(deserializePayload(row.encrypted_key)),
    })),
  );
}

function createNextKek(
  envelope: EnvelopeEncryption,
  currentVersion: number,
): NextKek {
  const key = envelope.generateKek();
  return {
    version: currentVersion + 1,
    key,
    encrypted: envelope.encryptKek(key),
  };
}

function rewrapConversationKeys(
  db: Db,
  envelope: EnvelopeEncryption,
  current: ActiveKek,
  next: NextKek,
): Effect.Effect<number, SqlError> {
  return transaction(db, (trx) =>
    Effect.gen(function* () {
      yield* insertNextKek(trx, next);

      const convKeys = yield* selectConversationKeysForKek(
        trx,
        current.version,
      );
      for (const row of convKeys) {
        yield* rewrapConversationKey(trx, envelope, { row, current, next });
        yield* updateMessageKekVersion(trx, row, current, next);
      }

      yield* deleteRetiredKek(trx, current.version);
      return convKeys.length;
    }),
  );
}

function insertNextKek(trx: Transaction<Database>, next: NextKek) {
  return trx.insertInto("encryption_keys").values({
    version: next.version,
    encrypted_key: serializePayload(next.encrypted),
    status: "active",
  });
}

function selectConversationKeysForKek(
  trx: Transaction<Database>,
  version: number,
) {
  return trx
    .selectFrom("conversation_keys")
    .select(["conversation_id", "dek_version", "wrapped_dek"])
    .where("kek_version", "=", version);
}

function rewrapConversationKey(
  trx: Transaction<Database>,
  envelope: EnvelopeEncryption,
  input: RewrapConversationKeyInput,
) {
  const reWrapped = envelope.rewrapDek(
    deserializePayload(input.row.wrapped_dek),
    input.current.key,
    input.next.key,
  );

  return trx
    .updateTable("conversation_keys")
    .set({
      wrapped_dek: serializePayload(reWrapped),
      kek_version: input.next.version,
    })
    .where("conversation_id", "=", input.row.conversation_id)
    .where("dek_version", "=", input.row.dek_version);
}

function updateMessageKekVersion(
  trx: Transaction<Database>,
  row: ConversationKeyForRotation,
  current: ActiveKek,
  next: NextKek,
) {
  return trx
    .updateTable("messages")
    .set({ kek_version: next.version })
    .where("conversation_id", "=", row.conversation_id)
    .where("dek_version", "=", row.dek_version)
    .where("kek_version", "=", current.version);
}

function deleteRetiredKek(trx: Transaction<Database>, version: number) {
  return trx.deleteFrom("encryption_keys").where("version", "=", version);
}
