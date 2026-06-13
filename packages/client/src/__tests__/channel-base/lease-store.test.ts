/**
 * Unit tests for the `LeaseStore` API.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { LeaseStore } from "../../channel-base/lease-store.js";

const JID_A = "mz:conv-a";
const JID_B = "mz:conv-b";
const LEASE_1 = "lease-1";
const LEASE_2 = "lease-2";
const LEASE_3 = "lease-3";

function makeStore(): LeaseStore<string, string> {
  return new LeaseStore<string, string>();
}

describe("LeaseStore", () => {
  it(
    "property: peek mirrors the latest remember without mutating",
    propertyPeekMirrorsLatest,
  );
  it(
    "remember overwrites an existing entry (last-write-wins)",
    rememberOverwrites,
  );
  it(
    "peek returns Option.none for missing keys without mutating state",
    peekMissingIsNone,
  );
  it(
    "peek returns Option.some(payload) for present keys without deleting",
    peekDoesNotDelete,
  );
  it(
    "consume returns the payload and deletes the entry",
    consumeReturnsAndDeletes,
  );
  it(
    "consume on a missing key returns Option.none without throwing",
    consumeMissingIsNoneSafe,
  );
  it("clear(key) clears that key only", clearByKey);
  it("clear() empties the store", clearAll);
  it("size reflects entry count across operations", sizeReflectsOps);
});

function propertyPeekMirrorsLatest(): void {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.string({ minLength: 1, maxLength: 32 }),
        ),
        { minLength: 1, maxLength: 8 },
      ),
      assertPeekMirrorsLatestRemember,
    ),
  );
}

function assertPeekMirrorsLatestRemember(
  writes: ReadonlyArray<readonly [string, string]>,
): void {
  const store = makeStore();
  const expectedLatest = new Map<string, string>();
  for (const [k, v] of writes) {
    Effect.runSync(store.remember(k, v));
    expectedLatest.set(k, v);
  }
  for (const [k, v] of expectedLatest) {
    expect(Option.getOrNull(Effect.runSync(store.peek(k)))).toBe(v);
  }
  // peek is non-mutating.
  expect(Effect.runSync(store.size)).toBe(expectedLatest.size);
}

function rememberOverwrites(): void {
  const store = makeStore();
  Effect.runSync(store.remember(JID_A, LEASE_1));
  Effect.runSync(store.remember(JID_A, LEASE_2));
  expect(Option.getOrNull(Effect.runSync(store.peek(JID_A)))).toBe(LEASE_2);
}

function peekMissingIsNone(): void {
  const store = makeStore();
  expect(Option.isNone(Effect.runSync(store.peek(JID_A)))).toBe(true);
  expect(Effect.runSync(store.size)).toBe(0);
}

function peekDoesNotDelete(): void {
  const store = makeStore();
  Effect.runSync(store.remember(JID_A, LEASE_1));
  const a = Effect.runSync(store.peek(JID_A));
  const b = Effect.runSync(store.peek(JID_A));
  expect(Option.getOrNull(a)).toBe(LEASE_1);
  expect(Option.getOrNull(b)).toBe(LEASE_1);
  expect(Effect.runSync(store.size)).toBe(1);
}

function consumeReturnsAndDeletes(): void {
  const store = makeStore();
  Effect.runSync(store.remember(JID_A, LEASE_1));
  expect(Option.getOrNull(Effect.runSync(store.consume(JID_A)))).toBe(LEASE_1);
  expect(Option.isNone(Effect.runSync(store.peek(JID_A)))).toBe(true);
}

function consumeMissingIsNoneSafe(): void {
  const store = makeStore();
  expect(Option.isNone(Effect.runSync(store.consume(JID_A)))).toBe(true);
}

function clearByKey(): void {
  const store = makeStore();
  Effect.runSync(store.remember(JID_A, LEASE_1));
  Effect.runSync(store.remember(JID_B, LEASE_2));
  Effect.runSync(store.clear(JID_A));
  expect(Option.isNone(Effect.runSync(store.peek(JID_A)))).toBe(true);
  expect(Option.getOrNull(Effect.runSync(store.peek(JID_B)))).toBe(LEASE_2);
}

function clearAll(): void {
  const store = makeStore();
  Effect.runSync(store.remember(JID_A, LEASE_1));
  Effect.runSync(store.remember(JID_B, LEASE_2));
  Effect.runSync(store.clear());
  expect(Effect.runSync(store.size)).toBe(0);
}

function sizeReflectsOps(): void {
  const store = makeStore();
  expect(Effect.runSync(store.size)).toBe(0);
  Effect.runSync(store.remember(JID_A, LEASE_1));
  expect(Effect.runSync(store.size)).toBe(1);
  Effect.runSync(store.remember(JID_B, LEASE_2));
  expect(Effect.runSync(store.size)).toBe(2);
  Effect.runSync(store.remember(JID_A, LEASE_3));
  expect(Effect.runSync(store.size)).toBe(2);
  Effect.runSync(store.consume(JID_A));
  expect(Effect.runSync(store.size)).toBe(1);
}
