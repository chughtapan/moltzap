/** @file Closed store errors, canonical value checks, and row projections. */

import { Data } from "effect";
import { randomBytes } from "node:crypto";

/** Closed storage failures that never expose SQLite diagnostics. */
export type EndpointStoreFailure =
  | "closed"
  | "conflict"
  | "corrupt"
  | "incompatible"
  | "invalid-continuation"
  | "invalid-input"
  | "not-found"
  | "persistence";

/** One closed endpoint-store failure. */
export class EndpointStoreError extends Data.TaggedError("EndpointStoreError")<{
  readonly reason: EndpointStoreFailure;
}> {}

/** Internal control-flow signal mapped to the closed store error. */
export class StoreSignal extends Error {
  readonly reason: EndpointStoreFailure;

  constructor(reason: EndpointStoreFailure) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Maps every internal failure to the store's closed error channel.
 *
 * @param failure Internal failure or closed control-flow signal.
 * @param fallback Closed category for unexpected implementation failures.
 * @returns A non-diagnostic endpoint-store error.
 */
export function mapStoreFailure(
  failure: unknown,
  fallback: EndpointStoreFailure,
): EndpointStoreError {
  return new EndpointStoreError({
    reason: failure instanceof StoreSignal ? failure.reason : fallback,
  });
}

/**
 * Validates a process-local continuation's exact external form.
 *
 * @param continuation Candidate unpadded base64url authority.
 */
export function validateContinuation(continuation: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(continuation)) {
    throw new StoreSignal("invalid-continuation");
  }
  const decoded = Buffer.from(continuation, "base64url");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64url") !== continuation
  ) {
    throw new StoreSignal("invalid-continuation");
  }
}

/**
 * Mints one collision-checked 32-byte volatile continuation.
 *
 * @param retained Existing process-local continuation keys.
 * @returns One fresh canonical unpadded base64url value.
 */
export function mintContinuation(retained: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const continuation = randomBytes(32).toString("base64url");
    if (!retained.has(continuation)) {
      return continuation;
    }
  }
  throw new StoreSignal("persistence");
}

/**
 * Reads and copies one nullable SQLite BLOB.
 *
 * @param row SQLite result row.
 * @param key Selected column name.
 * @returns An isolated byte copy, or undefined for SQL NULL.
 */
export function readOptionalBytes(
  row: Readonly<Record<string, unknown>>,
  key: string,
): Uint8Array | undefined {
  const value = row[key];
  if (value === null) {
    return undefined;
  }
  return readBytes(row, key);
}

/**
 * Reads and copies one required SQLite BLOB.
 *
 * @param row SQLite result row.
 * @param key Selected column name.
 * @returns An isolated nonempty byte copy.
 */
export function readBytes(
  row: Readonly<Record<string, unknown>>,
  key: string,
): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new StoreSignal("corrupt");
  }
  return copyBytes(value);
}

/**
 * Returns an isolated copy of canonical bytes.
 *
 * @param value Canonical bytes crossing the storage boundary.
 * @returns A detached copy suitable for SQLite or a caller.
 */
export function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

/**
 * Reads one nullable nonempty SQLite TEXT.
 *
 * @param row SQLite result row.
 * @param key Selected column name.
 * @returns The exact text, or undefined for SQL NULL.
 */
export function readOptionalText(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === null) {
    return undefined;
  }
  return readText(row, key);
}

/**
 * Reads one required nonempty SQLite TEXT.
 *
 * @param row SQLite result row when one was selected.
 * @param key Selected column name.
 * @returns The exact nonempty text.
 */
export function readText(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreSignal("corrupt");
  }
  return value;
}

/**
 * Reads one safe SQLite INTEGER.
 *
 * @param row SQLite result row when one was selected.
 * @param key Selected column name.
 * @returns The exact safe integer.
 */
export function readInteger(
  row: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new StoreSignal("corrupt");
  }
  return value;
}

/**
 * Requires canonical byte equality for idempotent state.
 *
 * @param left Previously retained canonical bytes.
 * @param right Candidate canonical bytes.
 */
export function requireSameBytes(left: Uint8Array, right: Uint8Array): void {
  if (
    left.byteLength !== right.byteLength ||
    !left.every((value, index) => value === right[index])
  ) {
    throw new StoreSignal("conflict");
  }
}

/**
 * Requires two exact bindings, including optional bindings, to agree.
 *
 * @param left Previously retained binding.
 * @param right Candidate binding.
 */
export function requireEqual<Value>(left: Value, right: Value): void {
  if (left !== right) {
    throw new StoreSignal("conflict");
  }
}

/**
 * Rejects empty and NUL-bearing values before they reach SQLite.
 *
 * @param value Opaque private identifier or hash.
 */
export function requireText(value: string): void {
  if (value.length === 0 || value.includes("\u0000")) {
    throw new StoreSignal("invalid-input");
  }
}

/**
 * Rejects empty or non-byte canonical values before persistence.
 *
 * @param value Canonical representation bytes.
 */
export function requireBytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new StoreSignal("invalid-input");
  }
}
