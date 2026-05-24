import { randomBytes, createHash } from "node:crypto";

/**
 * Stable string prefix on every agent API key. Encoded once here;
 * the docs constants generator
 * (`scripts/generate-constants-snippets.ts`) reads this literal via
 * the TS compiler API so doc copy stays in lockstep.
 */
const API_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 24;
const HEX_CHARS_PER_BYTE = 2;
const CLAIM_TOKEN_BYTES = 16;

/** Generate a Key ID + Secret API key with its derived storage values. */
export function generateApiKey(): {
  apiKey: string;
  keyId: string;
  secretHash: string;
} {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const apiKey = `${API_KEY_PREFIX}${keyId}_${secret}`;
  return { apiKey, keyId, secretHash: hashSecret(secret) };
}

/** Extract keyId and secret from a full API key string. */
export function parseApiKey(
  key: string,
): { keyId: string; secret: string } | null {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const rest = key.slice(API_KEY_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx !== KEY_ID_BYTES * HEX_CHARS_PER_BYTE) return null;
  const keyId = rest.slice(0, sepIdx);
  const secret = rest.slice(sepIdx + 1);
  if (secret.length !== SECRET_BYTES * HEX_CHARS_PER_BYTE) return null;
  return { keyId, secret };
}

/** SHA-256 hex digest of the secret portion. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateClaimToken(): string {
  return "MZAP-" + randomBytes(CLAIM_TOKEN_BYTES).toString("hex").toUpperCase();
}
