import type { EncryptedPayload } from "./envelope.js";
import { Data } from "effect";

class EncryptedPayloadParseError extends Data.TaggedError(
  "EncryptedPayloadParseError",
)<{ readonly message: string }> {}

/**
 * Executes the serialize payload operation.
 * @param p Value supplied to the operation.
 * @returns The serialize payload result.
 */
export function serializePayload(p: EncryptedPayload): string {
  return JSON.stringify({
    c: p.ciphertext.toString("base64"),
    i: p.iv.toString("base64"),
    t: p.tag.toString("base64"),
  });
}

/**
 * Executes the deserialize payload operation.
 * @param s Value supplied to the operation.
 * @returns The deserialize payload result.
 */
export function deserializePayload(s: string): EncryptedPayload {
  const parsed: unknown = JSON.parse(s);
  if (!isSerializedPayload(parsed)) {
    throw new EncryptedPayloadParseError({
      message: "Encrypted payload must contain base64 c, i, and t fields.",
    });
  }
  return {
    ciphertext: Buffer.from(parsed.c, "base64"),
    iv: Buffer.from(parsed.i, "base64"),
    tag: Buffer.from(parsed.t, "base64"),
  };
}

function isSerializedPayload(
  value: unknown,
): value is { readonly c: string; readonly i: string; readonly t: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    hasStringProperty(value, "c") &&
    hasStringProperty(value, "i") &&
    hasStringProperty(value, "t")
  );
}

function hasStringProperty<Key extends PropertyKey>(
  value: object,
  key: Key,
): value is Record<Key, string> {
  return key in value && typeof Reflect.get(value, key) === "string";
}
