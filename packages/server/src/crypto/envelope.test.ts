import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  encrypt,
  decrypt,
  wrapKey,
  unwrapKey,
  generateDek,
  EnvelopeEncryption,
} from "./envelope.js";
import { randomBytes } from "node:crypto";

describe("encrypt/decrypt", () => {
  it("roundtrips arbitrary data", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 10000 }), (data) => {
        const key = randomBytes(32);
        const plaintext = Buffer.from(data);
        const encrypted = encrypt(plaintext, key);
        const decrypted = decrypt(encrypted, key);
        expect(decrypted).toEqual(plaintext);
      }),
      { numRuns: 100 },
    );
  });

  it("produces unique IVs per encryption", () => {
    const key = randomBytes(32);
    const plaintext = Buffer.from("same data");
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails with wrong key", () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const encrypted = encrypt(Buffer.from("secret"), key);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("fails with corrupted ciphertext", () => {
    const key = randomBytes(32);
    const encrypted = encrypt(Buffer.from("secret"), key);
    encrypted.ciphertext[0]! ^= 0xff;
    expect(() => decrypt(encrypted, key)).toThrow();
  });

  it("fails with corrupted tag", () => {
    const key = randomBytes(32);
    const encrypted = encrypt(Buffer.from("secret"), key);
    encrypted.tag[0]! ^= 0xff;
    expect(() => decrypt(encrypted, key)).toThrow();
  });
});

describe("key wrapping", () => {
  it("roundtrips DEK through KEK", () => {
    const kek = randomBytes(32);
    const dek = generateDek();
    const wrapped = wrapKey(dek, kek);
    const unwrapped = unwrapKey(wrapped, kek);
    expect(unwrapped).toEqual(dek);
  });

  it("fails with wrong KEK", () => {
    const kek = randomBytes(32);
    const wrongKek = randomBytes(32);
    const dek = generateDek();
    const wrapped = wrapKey(dek, kek);
    expect(() => unwrapKey(wrapped, wrongKek)).toThrow();
  });
});

describe("EnvelopeEncryption", () => {
  const masterSecret = randomBytes(32).toString("base64");
  const envelope = new EnvelopeEncryption(masterSecret);

  it("roundtrips KEK through master secret", () => {
    const kek = randomBytes(32);
    const encrypted = envelope.encryptKek(kek);
    const decrypted = envelope.decryptKek(encrypted);
    expect(decrypted).toEqual(kek);
  });

  it("roundtrips message parts through DEK", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 1000 }), (text) => {
        const dek = generateDek();
        const parts = [{ type: "text", text }];
        const encrypted = envelope.encryptMessage(parts, dek);
        const decrypted = envelope.decryptMessage(encrypted, dek);
        expect(decrypted).toEqual(parts);
      }),
      { numRuns: 50 },
    );
  });

  it("simulates KEK rotation without re-encrypting messages", () => {
    const kekV1 = randomBytes(32);
    const dek = generateDek();
    const wrappedDekV1 = wrapKey(dek, kekV1);
    const message = envelope.encryptMessage(
      [{ type: "text", text: "original" }],
      dek,
    );

    // Rotate: wrap same DEK with new KEK v2
    const kekV2 = randomBytes(32);
    const unwrappedDek = unwrapKey(wrappedDekV1, kekV1);
    const wrappedDekV2 = wrapKey(unwrappedDek, kekV2);

    // Verify: old message still decrypts with DEK from new wrapping
    const dekFromV2 = unwrapKey(wrappedDekV2, kekV2);
    const decrypted = envelope.decryptMessage(message, dekFromV2);
    expect(decrypted).toEqual([{ type: "text", text: "original" }]);
  });
});
