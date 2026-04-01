import { randomBytes, createHash } from "node:crypto";

const API_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 24;

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
  if (sepIdx !== KEY_ID_BYTES * 2) return null;
  const keyId = rest.slice(0, sepIdx);
  const secret = rest.slice(sepIdx + 1);
  if (secret.length !== SECRET_BYTES * 2) return null;
  return { keyId, secret };
}

/** SHA-256 hex digest of the secret portion. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateClaimToken(): string {
  return "MZAP-" + randomBytes(16).toString("hex").toUpperCase();
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidApiKeyFormat(key: string): boolean {
  return parseApiKey(key) !== null;
}
