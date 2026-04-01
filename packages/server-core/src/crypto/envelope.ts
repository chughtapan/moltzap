import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";

/**
 * Envelope encryption layer:
 *
 *   Master Secret (env var)
 *     -> encrypts -> KEK (versioned, in encryption_keys table)
 *         -> wraps -> DEK (per-conversation, in conversation_keys table)
 *             -> encrypts -> Message parts (AES-256-GCM)
 *
 * KEK rotation: re-wrap DEKs with new KEK (no message re-encryption)
 * DEK rotation: new DEK version per conversation (old messages keep old DEK)
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encrypt(plaintext: Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

function deriveKeyFromSecret(masterSecret: string): Buffer {
  return createHash("sha256")
    .update(Buffer.from(masterSecret, "base64"))
    .digest();
}

export function wrapKey(dek: Buffer, kek: Buffer): EncryptedPayload {
  return encrypt(dek, kek);
}

export function unwrapKey(wrapped: EncryptedPayload, kek: Buffer): Buffer {
  return decrypt(wrapped, kek);
}

export function generateDek(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export class EnvelopeEncryption {
  private masterKey: Buffer;

  constructor(masterSecret: string) {
    this.masterKey = deriveKeyFromSecret(masterSecret);
  }

  encryptKek(kek: Buffer): EncryptedPayload {
    return encrypt(kek, this.masterKey);
  }

  decryptKek(wrapped: EncryptedPayload): Buffer {
    return decrypt(wrapped, this.masterKey);
  }

  encryptMessage(parts: unknown, dek: Buffer): EncryptedPayload {
    const plaintext = Buffer.from(JSON.stringify(parts), "utf-8");
    return encrypt(plaintext, dek);
  }

  decryptMessage(payload: EncryptedPayload, dek: Buffer): unknown {
    const plaintext = decrypt(payload, dek);
    return JSON.parse(plaintext.toString("utf-8"));
  }
}
