import type { Db } from "../db/client.js";
import { EnvelopeEncryption, wrapKey, unwrapKey } from "./envelope.js";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { serializePayload, deserializePayload } from "./serialization.js";
import { sql } from "kysely";
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

export function seedInitialKek(
  db: Db,
  envelope: EnvelopeEncryption,
  // #ignore-sloppy-code-next-line[promise-type]: migration API remains Promise-native for existing callers
): Promise<void> {
  return Effect.runPromise(seedInitialKekEffect(db, envelope));
}

export function rotateKek(
  db: Db,
  envelope: EnvelopeEncryption,
  // #ignore-sloppy-code-next-line[promise-type]: admin/ops API remains Promise-native for existing callers
): Promise<number> {
  return Effect.runPromise(rotateKekEffect(db, envelope));
}

function seedInitialKekEffect(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<void, SqlError, never> {
  return Effect.gen(function* () {
    const kek = randomBytes(32);
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

    logger.info("Seeded initial KEK version 1");
  });
}

function rotateKekEffect(
  db: Db,
  envelope: EnvelopeEncryption,
): Effect.Effect<number, SqlError | KeyRotationError, never> {
  return Effect.gen(function* () {
    const current = yield* takeFirstOrElse(
      db
        .selectFrom("encryption_keys")
        .select(["version", "encrypted_key"])
        .where("status", "=", "active")
        .orderBy("version", "desc")
        .limit(1),
      () => new KeyRotationError({ reason: "No active KEK found" }),
    );

    const currentVersion = current.version;
    const currentKek = envelope.decryptKek(
      deserializePayload(current.encrypted_key),
    );

    const newVersion = currentVersion + 1;
    const newKek = randomBytes(32);
    const encryptedNewKek = envelope.encryptKek(newKek);

    const reWrappedCount = yield* transaction(db, (trx) =>
      Effect.gen(function* () {
        yield* trx.insertInto("encryption_keys").values({
          version: newVersion,
          encrypted_key: serializePayload(encryptedNewKek),
          status: "active",
        });

        const convKeys = yield* trx
          .selectFrom("conversation_keys")
          .select([
            "conversation_id",
            "dek_version",
            "wrapped_dek",
            "kek_version",
          ])
          .where("kek_version", "=", currentVersion);

        for (const row of convKeys) {
          const wrappedDek = deserializePayload(row.wrapped_dek);
          const dek = unwrapKey(wrappedDek, currentKek);
          const reWrapped = wrapKey(dek, newKek);

          yield* trx
            .updateTable("conversation_keys")
            .set({
              wrapped_dek: serializePayload(reWrapped),
              kek_version: newVersion,
            })
            .where("conversation_id", "=", row.conversation_id)
            .where("dek_version", "=", row.dek_version);
        }

        yield* trx
          .updateTable("encryption_keys")
          .set({ status: "deprecated", rotated_at: sql`now()` })
          .where("version", "=", currentVersion);

        return convKeys.length;
      }),
    );

    logger.info(
      {
        oldVersion: currentVersion,
        newVersion,
        reWrappedCount,
      },
      "KEK rotated",
    );
    return newVersion;
  });
}

// Re-export for consumers that imported from here
export { serializePayload, deserializePayload } from "./serialization.js";
