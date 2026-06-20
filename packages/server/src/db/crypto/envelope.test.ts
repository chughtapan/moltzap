import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import * as fc from "fast-check";
import { ServerEncryptionMasterSecret } from "#config/secrets";
import { EnvelopeEncryption } from "./envelope.js";
import { randomBytes } from "node:crypto";

const AES_KEY_BYTES = 32;

function makeEnvelope() {
  const masterSecret = Schema.decodeUnknownSync(ServerEncryptionMasterSecret)(
    randomBytes(AES_KEY_BYTES).toString("base64"),
  );
  return new EnvelopeEncryption(masterSecret);
}

describe("EnvelopeEncryption messages", () => {
  const envelope = makeEnvelope();

  it("roundtrips message parts through generated DEKs", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 1000 }), (text) => {
        const dek = envelope.generateDek();
        const parts = [{ type: "text", text }];
        const encrypted = envelope.encryptMessage(parts, dek);
        const decrypted = envelope.decryptMessage(encrypted, dek);
        expect(decrypted).toEqual(parts);
      }),
      { numRuns: 50 },
    );
  });

  it("produces unique IVs per message encryption", () => {
    const dek = envelope.generateDek();
    const parts = [{ type: "text", text: "same data" }];
    const a = envelope.encryptMessage(parts, dek);
    const b = envelope.encryptMessage(parts, dek);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails message decrypt with the wrong DEK", () => {
    const dek = envelope.generateDek();
    const wrongDek = envelope.generateDek();
    const encrypted = envelope.encryptMessage(
      [{ type: "text", text: "secret" }],
      dek,
    );
    expect(() => envelope.decryptMessage(encrypted, wrongDek)).toThrow();
  });

  it("fails message decrypt with corrupted ciphertext", () => {
    const dek = envelope.generateDek();
    const encrypted = envelope.encryptMessage(
      [{ type: "text", text: "secret" }],
      dek,
    );
    encrypted.ciphertext[0]! ^= 0xff;
    expect(() => envelope.decryptMessage(encrypted, dek)).toThrow();
  });

  it("fails message decrypt with corrupted tag", () => {
    const dek = envelope.generateDek();
    const encrypted = envelope.encryptMessage(
      [{ type: "text", text: "secret" }],
      dek,
    );
    encrypted.tag[0]! ^= 0xff;
    expect(() => envelope.decryptMessage(encrypted, dek)).toThrow();
  });
});

describe("EnvelopeEncryption keys", () => {
  const envelope = makeEnvelope();

  it("roundtrips DEKs through KEKs", () => {
    const kek = envelope.generateKek();
    const dek = envelope.generateDek();
    const wrapped = envelope.wrapDek(dek, kek);
    const unwrapped = envelope.unwrapDek(wrapped, kek);
    const encrypted = envelope.encryptMessage(
      [{ type: "text", text: "wrapped" }],
      dek,
    );
    expect(envelope.decryptMessage(encrypted, unwrapped)).toEqual([
      { type: "text", text: "wrapped" },
    ]);
  });

  it("fails to unwrap DEK with wrong KEK", () => {
    const kek = envelope.generateKek();
    const wrongKek = envelope.generateKek();
    const dek = envelope.generateDek();
    const wrapped = envelope.wrapDek(dek, kek);
    expect(() => envelope.unwrapDek(wrapped, wrongKek)).toThrow();
  });

  it("simulates KEK rotation without re-encrypting messages", () => {
    const kekV1 = envelope.generateKek();
    const dek = envelope.generateDek();
    const wrappedDekV1 = envelope.wrapDek(dek, kekV1);
    const message = envelope.encryptMessage(
      [{ type: "text", text: "original" }],
      dek,
    );

    const kekV2 = envelope.generateKek();
    const wrappedDekV2 = envelope.rewrapDek(wrappedDekV1, kekV1, kekV2);

    const dekFromV2 = envelope.unwrapDek(wrappedDekV2, kekV2);
    const decrypted = envelope.decryptMessage(message, dekFromV2);
    expect(decrypted).toEqual([{ type: "text", text: "original" }]);
  });
});
