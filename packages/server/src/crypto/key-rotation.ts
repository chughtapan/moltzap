import type { Db } from "../db/client.js";
import { EnvelopeEncryption, wrapKey, unwrapKey } from "./envelope.js";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { serializePayload, deserializePayload } from "./serialization.js";
import { sql } from "kysely";

export async function seedInitialKek(
  db: Db,
  envelope: EnvelopeEncryption,
): Promise<void> {
  const kek = randomBytes(32);
  const encrypted = envelope.encryptKek(kek);
  const serialized = serializePayload(encrypted);

  await db
    .insertInto("encryption_keys")
    .values({
      version: 1,
      encrypted_key: serialized,
      status: "active",
    })
    .onConflict((oc) => oc.column("version").doNothing())
    .execute();

  logger.info("Seeded initial KEK version 1");
}

export async function rotateKek(
  db: Db,
  envelope: EnvelopeEncryption,
): Promise<number> {
  const current = await db
    .selectFrom("encryption_keys")
    .select(["version", "encrypted_key"])
    .where("status", "=", "active")
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!current) throw new Error("No active KEK found");

  const currentVersion = current.version;
  const currentKek = envelope.decryptKek(
    deserializePayload(current.encrypted_key),
  );

  const newVersion = currentVersion + 1;
  const newKek = randomBytes(32);
  const encryptedNewKek = envelope.encryptKek(newKek);

  const reWrappedCount = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("encryption_keys")
      .values({
        version: newVersion,
        encrypted_key: serializePayload(encryptedNewKek),
        status: "active",
      })
      .execute();

    // Re-wrap all conversation DEKs
    const convKeys = await trx
      .selectFrom("conversation_keys")
      .select(["conversation_id", "dek_version", "wrapped_dek", "kek_version"])
      .where("kek_version", "=", currentVersion)
      .execute();

    for (const row of convKeys) {
      const wrappedDek = deserializePayload(row.wrapped_dek);
      const dek = unwrapKey(wrappedDek, currentKek);
      const reWrapped = wrapKey(dek, newKek);

      await trx
        .updateTable("conversation_keys")
        .set({
          wrapped_dek: serializePayload(reWrapped),
          kek_version: newVersion,
        })
        .where("conversation_id", "=", row.conversation_id)
        .where("dek_version", "=", row.dek_version)
        .execute();
    }

    // Deprecate old KEK
    await trx
      .updateTable("encryption_keys")
      .set({ status: "deprecated", rotated_at: sql`now()` })
      .where("version", "=", currentVersion)
      .execute();

    return convKeys.length;
  });

  logger.info(
    {
      oldVersion: currentVersion,
      newVersion,
      reWrappedCount,
    },
    "KEK rotated",
  );
  return newVersion;
}

// Re-export for consumers that imported from here
export { serializePayload, deserializePayload } from "./serialization.js";
