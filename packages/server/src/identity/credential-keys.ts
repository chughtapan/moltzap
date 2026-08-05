/**
 * @file Key-ID + Secret credential toolkit for agent API keys: the
 * generate/parse primitives plus the constant-time compare and secret hash
 * every credential path shares.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Redacted, Schema } from "effect";
import { type AgentKey, agentKey } from "@moltzap/protocol/identity";

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

/**
 * Generate a Key ID + Secret API key with its derived storage values. The
 * plaintext key is returned once; only `keyId` + `secretHash` persist.
 * @returns The generate api key result.
 */
export function generateApiKey(): {
  apiKey: AgentKey;
  keyId: string;
  secretHash: string;
} {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  return {
    apiKey: Schema.decodeUnknownSync(agentKey)(
      `${API_KEY_PREFIX}${keyId}_${secret}`,
    ),
    keyId,
    secretHash: hashSecret(secret),
  };
}

/**
 * Extract keyId and secret from a full API key string.
 * @param keyValue Value supplied to the operation.
 * @returns The decoded api key.
 */
export function parseApiKey(
  keyValue: AgentKey,
): { keyId: string; secret: string } | null {
  const key = Redacted.value(keyValue);
  if (!key.startsWith(API_KEY_PREFIX)) {
    return null;
  }
  const rest = key.slice(API_KEY_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx !== KEY_ID_BYTES * HEX_CHARS_PER_BYTE) {
    return null;
  }
  const keyId = rest.slice(0, sepIdx);
  const secret = rest.slice(sepIdx + 1);
  if (secret.length !== SECRET_BYTES * HEX_CHARS_PER_BYTE) {
    return null;
  }
  return { keyId, secret };
}

/**
 * Constant-time string comparison. Shared by every credential-compare
 * path (agent auth, invite-code gate) so the timing-safe property is
 * enforced in one place rather than re-derived per call site.
 * Length mismatch short-circuits to `false` (the lengths are not secret).
 * @param a Value supplied to the operation.
 * @param b Value supplied to the operation.
 * @returns The safe equal result.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * SHA-256 hex digest of the secret portion.
 * @param secret Value supplied to the operation.
 * @returns Whether h secret.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
