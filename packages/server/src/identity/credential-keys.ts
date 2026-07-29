/**
 * @file Shared Key-ID + Secret credential toolkit for BOTH principal kinds:
 * the generate/parse primitives for agent API keys (`API_KEY_PREFIX`) AND app
 * keys (`APP_KEY_PREFIX`). `generateKeyWithPrefix` / `parseKeyWithPrefix` are
 * the prefix-parameterized core both principal credentials share.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Redacted, Schema } from "effect";
import {
  type AgentKey,
  agentKey,
  type AppKey,
  appKey,
} from "@moltzap/protocol/identity";

/**
 * Stable string prefix on every agent API key. Encoded once here;
 * the docs constants generator
 * (`scripts/generate-constants-snippets.ts`) reads this literal via
 * the TS compiler API so doc copy stays in lockstep.
 */
const API_KEY_PREFIX = "moltzap_agent_";
/** Stable string prefix on every app key. Sibling of `API_KEY_PREFIX`. */
const APP_KEY_PREFIX = "moltzap_app_";
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 24;
const HEX_CHARS_PER_BYTE = 2;

/** Generate a Key ID + Secret API key with its derived storage values. */
export function generateApiKey(): {
  apiKey: AgentKey;
  keyId: string;
  secretHash: string;
} {
  const { apiKey, keyId, secretHash } = generateKeyWithPrefix(API_KEY_PREFIX);
  return {
    apiKey: Schema.decodeUnknownSync(agentKey)(apiKey),
    keyId,
    secretHash,
  };
}

/**
 * Generate an app key with its derived storage values. Same Key ID +
 * Secret shape as {@link generateApiKey}, under the `APP_KEY_PREFIX`.
 * Plaintext key is returned once; only `keyId` + `secretHash` persist.
 */
export function generateAppKey(): {
  appKey: AppKey;
  keyId: string;
  secretHash: string;
} {
  const { apiKey, keyId, secretHash } = generateKeyWithPrefix(APP_KEY_PREFIX);
  return {
    appKey: Schema.decodeUnknownSync(appKey)(apiKey),
    keyId,
    secretHash,
  };
}

function generateKeyWithPrefix(prefix: string): {
  apiKey: string;
  keyId: string;
  secretHash: string;
} {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const apiKey = `${prefix}${keyId}_${secret}`;
  return { apiKey, keyId, secretHash: hashSecret(secret) };
}

/** Extract keyId and secret from a full API key string. */
export function parseApiKey(
  key: AgentKey,
): { keyId: string; secret: string } | null {
  return parseKeyWithPrefix(Redacted.value(key), API_KEY_PREFIX);
}

/** Extract keyId and secret from a full app key string. */
export function parseAppKey(
  key: AppKey,
): { keyId: string; secret: string } | null {
  return parseKeyWithPrefix(Redacted.value(key), APP_KEY_PREFIX);
}

function parseKeyWithPrefix(
  key: string,
  prefix: string,
): { keyId: string; secret: string } | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx !== KEY_ID_BYTES * HEX_CHARS_PER_BYTE) return null;
  const keyId = rest.slice(0, sepIdx);
  const secret = rest.slice(sepIdx + 1);
  if (secret.length !== SECRET_BYTES * HEX_CHARS_PER_BYTE) return null;
  return { keyId, secret };
}

/**
 * Constant-time string comparison. Shared by every credential-compare
 * path (agent auth, app auth, invite-code gate) so the timing-safe
 * property is enforced in one place rather than re-derived per call site.
 * Length mismatch short-circuits to `false` (the lengths are not secret).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** SHA-256 hex digest of the secret portion. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
