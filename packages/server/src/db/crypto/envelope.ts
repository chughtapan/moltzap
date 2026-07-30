import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { Redacted } from "effect";
import type { ServerEncryptionMasterSecret } from "#config/secrets";
import { Dek } from "./dek.js";
import { Kek } from "./kek.js";
import { MasterKey } from "./master-key.js";

/**
 * Envelope encryption layer:
 *
 *   Master Secret (env var)
 *     -> encrypts -> KEK (versioned, in encryption_keys table)
 *         -> wraps -> DEK (per-conversation, in conversation_keys table)
 *             -> encrypts -> Message parts (AES-256-GCM).
 *
 * KEK rotation: re-wrap DEKs with new KEK (no message re-encryption)
 * DEK rotation: new DEK version per conversation (old messages keep old DEK).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/** Describes encrypted payload. */
export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function keyBytes(key: Kek | Dek | MasterKey): Buffer {
  return key.toBuffer();
}

function encryptBytes(plaintext: Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

function decryptBytes(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

function deriveKeyFromSecret(
  masterSecret: ServerEncryptionMasterSecret,
): MasterKey {
  return MasterKey.fromBytes(
    createHash("sha256")
      .update(Buffer.from(Redacted.value(masterSecret), "base64"))
      .digest(),
  );
}

function generateKeyMaterial(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/** Implements envelope encryption. */
export class EnvelopeEncryption {
  private readonly masterKey: MasterKey;

  constructor(masterSecret: ServerEncryptionMasterSecret) {
    this.masterKey = deriveKeyFromSecret(masterSecret);
  }

  generateKek(): Kek {
    return Kek.fromBytes(generateKeyMaterial());
  }

  generateDek(): Dek {
    return Dek.fromBytes(generateKeyMaterial());
  }

  encryptKek(key: Kek): EncryptedPayload {
    return encryptBytes(keyBytes(key), keyBytes(this.masterKey));
  }

  decryptKek(wrapped: EncryptedPayload): Kek {
    return Kek.fromBytes(decryptBytes(wrapped, keyBytes(this.masterKey)));
  }

  wrapDek(key: Dek, wrappingKey: Kek): EncryptedPayload {
    return encryptBytes(keyBytes(key), keyBytes(wrappingKey));
  }

  unwrapDek(wrapped: EncryptedPayload, wrappingKey: Kek): Dek {
    return Dek.fromBytes(decryptBytes(wrapped, keyBytes(wrappingKey)));
  }

  rewrapDek(
    wrapped: EncryptedPayload,
    currentKek: Kek,
    nextKek: Kek,
  ): EncryptedPayload {
    return this.wrapDek(this.unwrapDek(wrapped, currentKek), nextKek);
  }

  encryptMessage(parts: unknown, key: Dek): EncryptedPayload {
    const plaintext = Buffer.from(JSON.stringify(parts), "utf-8");
    return encryptBytes(plaintext, keyBytes(key));
  }

  decryptMessage(payload: EncryptedPayload, key: Dek): unknown {
    const plaintext = decryptBytes(payload, keyBytes(key));
    return JSON.parse(plaintext.toString("utf-8"));
  }
}
