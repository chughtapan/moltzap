import type { Db } from "../db/client.js";
import type { Database } from "../db/database.js";
import type { Selectable, Transaction } from "../db/kysely-vendor.js";
import {
  EnvelopeEncryption,
  generateKeyMaterial,
  wrapKey,
  unwrapKey,
  type EncryptedPayload,
} from "./envelope.js";
import { serializePayload, deserializePayload } from "./serialization.js";
import { sql } from "../db/sql.js";
import { Data, Effect } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import { takeFirstOrElse, transaction } from "../db/effect-kysely-toolkit.js";

class KeyRotationError extends Data.TaggedError("KeyRotationError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const KEK_BYTES = 32;

interface ActiveKek {
  readonly version: number;
  readonly key: Buffer;
}

interface NextKek {
  readonly version: number;
  readonly key: Buffer;
  readonly encrypted: EncryptedPayload;
}

interface ConversationKeyForRotation
  extends Pick<
    Selectable<Database["conversation_keys"]>,
    "conversation_id" | "dek_version" | "wrapped_dek"
  > {}

export function seedInitialKek(db: Db, envelope: EnvelopeEncryption) {
  return Effect.runPromise(seedInitialKekEffect(db, envelope));
}

export function rotateKek(db: Db, envelope: EnvelopeEncryption) {
  return Effect.runPromise(rotateKekEffect(db, envelope));
}

function seedInitialKekEffect(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<void, SqlError, never> {
  return Effect.gen(function* () {
    const kek = generateKek();
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
): Effect.Effect<number, SqlError | KeyRotationError, never> {
  return Effect.gen(function* () {
    const current = yield* loadActiveKek(db, envelope);
    const next = createNextKek(envelope, current.version);
    const reWrappedCount = yield* rewrapConversationKeys(db, current, next);

    logKekRotation(current.version, next.version, reWrappedCount);
    return next.version;
  });
}

function generateKek(): Buffer {
  return generateKeyMaterial().subarray(0, KEK_BYTES);
}

function loadActiveKek(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<ActiveKek, SqlError | KeyRotationError, never> {
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
  const key = generateKek();
  return {
    version: currentVersion + 1,
    key,
    encrypted: envelope.encryptKek(key),
  };
}

function rewrapConversationKeys(
  db: Db,
  current: ActiveKek,
  next: NextKek,
): Effect.Effect<number, SqlError, never> {
  return transaction(db, (trx) =>
    Effect.gen(function* () {
      yield* insertNextKek(trx, next);

      const convKeys = yield* selectConversationKeysForKek(
        trx,
        current.version,
      );
      for (const row of convKeys) {
        yield* rewrapConversationKey(trx, row, current, next);
      }

      yield* deprecateKek(trx, current.version);
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
    .select(["conversation_id", "dek_version", "wrapped_dek", "kek_version"])
    .where("kek_version", "=", version);
}

function rewrapConversationKey(
  trx: Transaction<Database>,
  row: ConversationKeyForRotation,
  current: ActiveKek,
  next: NextKek,
) {
  const dek = unwrapKey(deserializePayload(row.wrapped_dek), current.key);
  const reWrapped = wrapKey(dek, next.key);

  return trx
    .updateTable("conversation_keys")
    .set({
      wrapped_dek: serializePayload(reWrapped),
      kek_version: next.version,
    })
    .where("conversation_id", "=", row.conversation_id)
    .where("dek_version", "=", row.dek_version);
}

function deprecateKek(trx: Transaction<Database>, version: number) {
  return trx
    .updateTable("encryption_keys")
    .set({ status: "deprecated", rotated_at: sql`now()` })
    .where("version", "=", version);
}

function logKekRotation(
  oldVersion: number,
  newVersion: number,
  reWrappedCount: number,
) {
  Effect.runFork(
    Effect.logInfo("KEK rotated").pipe(
      Effect.annotateLogs({ oldVersion, newVersion, reWrappedCount }),
    ),
  );
}
