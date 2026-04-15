import type { EncryptedPayload } from "./envelope.js";

export function serializePayload(p: EncryptedPayload): string {
  return JSON.stringify({
    c: p.ciphertext.toString("base64"),
    i: p.iv.toString("base64"),
    t: p.tag.toString("base64"),
  });
}

export function deserializePayload(s: string): EncryptedPayload {
  const parsed = JSON.parse(s);
  return {
    ciphertext: Buffer.from(parsed.c, "base64"),
    iv: Buffer.from(parsed.i, "base64"),
    tag: Buffer.from(parsed.t, "base64"),
  };
}
