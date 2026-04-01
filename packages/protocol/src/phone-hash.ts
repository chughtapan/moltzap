import { createHash } from "node:crypto";

/**
 * Ensure phone has E.164 '+' prefix.
 * GoTrue strips '+' from phone numbers in API responses.
 */
export function normalizeE164(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

/** SHA-256 hash of an E.164 phone number for privacy-preserving contact discovery. */
export function hashPhone(e164Phone: string): string {
  return createHash("sha256").update(e164Phone).digest("hex");
}

/** Validates that a string is a 64-character lowercase hex SHA-256 hash. */
export function isValidPhoneHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}
