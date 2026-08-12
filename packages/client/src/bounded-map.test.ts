/** @file Pins capacity, eviction, refresh, and iteration behavior for BoundedMap. */

import { describe, expect, it } from "vitest";
import { BoundedMap } from "./bounded-map.js";

const CAPACITY = 2;
const EMPTY_SIZE = 0;
const SINGLE_ENTRY_SIZE = 1;
const FULL_SIZE = 2;

const KEY_ALPHA = "alpha";
const KEY_BETA = "beta";
const KEY_GAMMA = "gamma";
const VALUE_ALPHA = "value-alpha";
const VALUE_ALPHA_REFRESHED = "value-alpha-refreshed";
const VALUE_BETA = "value-beta";
const VALUE_GAMMA = "value-gamma";

const ALPHA_ENTRY: readonly [string, string] = [KEY_ALPHA, VALUE_ALPHA];
const ALPHA_REFRESHED_ENTRY: readonly [string, string] = [
  KEY_ALPHA,
  VALUE_ALPHA_REFRESHED,
];
const BETA_ENTRY: readonly [string, string] = [KEY_BETA, VALUE_BETA];
const GAMMA_ENTRY: readonly [string, string] = [KEY_GAMMA, VALUE_GAMMA];
const EMPTY_ENTRIES: ReadonlyArray<readonly [string, string]> = [];
const FIFO_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  BETA_ENTRY,
  GAMMA_ENTRY,
];
const REFRESHED_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ALPHA_REFRESHED_ENTRY,
  GAMMA_ENTRY,
];
const EXPECTED_KEYS: readonly string[] = [KEY_BETA, KEY_GAMMA];
const EXPECTED_VALUES: readonly string[] = [VALUE_BETA, VALUE_GAMMA];
const INVALID_CAPACITY_MESSAGE =
  "BoundedMap capacity must be a positive safe integer";

const INVALID_CAPACITIES: readonly number[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];

describe("BoundedMap", () => {
  it("keeps at most capacity entries and evicts in FIFO order", boundsFifo);
  it(
    "refreshes an existing key on set before choosing the next eviction",
    refreshesOnSet,
  );
  it("does not refresh insertion order on get", getDoesNotRefresh);
  it("supports deletion and clearing", supportsDeleteAndClear);
  it("iterates entries, keys, and values in insertion order", iteratesInOrder);
  it("visits entries through ReadonlyMap-compatible forEach", visitsForEach);
  it("rejects capacities that are not positive safe integers", rejectsInvalid);
});

function boundsFifo(): void {
  const entries = makeMap();

  expect(entries.set(KEY_ALPHA, VALUE_ALPHA)).toBeUndefined();
  expect(entries.set(KEY_BETA, VALUE_BETA)).toBeUndefined();
  expect(entries.size).toBe(FULL_SIZE);

  expect(entries.set(KEY_GAMMA, VALUE_GAMMA)).toEqual(ALPHA_ENTRY);
  expect(entries.size).toBe(FULL_SIZE);
  expect(entries.has(KEY_ALPHA)).toBe(false);
  expect(entries.get(KEY_BETA)).toBe(VALUE_BETA);
  expect([...entries]).toEqual(FIFO_ENTRIES);
}

function refreshesOnSet(): void {
  const entries = makeMap();
  entries.set(KEY_ALPHA, VALUE_ALPHA);
  entries.set(KEY_BETA, VALUE_BETA);

  expect(entries.set(KEY_ALPHA, VALUE_ALPHA_REFRESHED)).toBeUndefined();
  expect(entries.set(KEY_GAMMA, VALUE_GAMMA)).toEqual(BETA_ENTRY);
  expect(entries.get(KEY_ALPHA)).toBe(VALUE_ALPHA_REFRESHED);
  expect([...entries]).toEqual(REFRESHED_ENTRIES);
}

function getDoesNotRefresh(): void {
  const entries = makeMap();
  entries.set(KEY_ALPHA, VALUE_ALPHA);
  entries.set(KEY_BETA, VALUE_BETA);

  expect(entries.get(KEY_ALPHA)).toBe(VALUE_ALPHA);
  expect(entries.set(KEY_GAMMA, VALUE_GAMMA)).toEqual(ALPHA_ENTRY);
  expect([...entries]).toEqual(FIFO_ENTRIES);
}

function supportsDeleteAndClear(): void {
  const entries = makeMap();
  entries.set(KEY_ALPHA, VALUE_ALPHA);
  entries.set(KEY_BETA, VALUE_BETA);

  expect(entries.delete(KEY_ALPHA)).toBe(true);
  expect(entries.delete(KEY_ALPHA)).toBe(false);
  expect(entries.size).toBe(SINGLE_ENTRY_SIZE);

  entries.clear();
  expect(entries.size).toBe(EMPTY_SIZE);
  expect([...entries]).toEqual(EMPTY_ENTRIES);
}

function iteratesInOrder(): void {
  const entries = makeMap();
  entries.set(KEY_BETA, VALUE_BETA);
  entries.set(KEY_GAMMA, VALUE_GAMMA);

  expect([...entries.entries()]).toEqual(FIFO_ENTRIES);
  expect([...entries.keys()]).toEqual(EXPECTED_KEYS);
  expect([...entries.values()]).toEqual(EXPECTED_VALUES);
}

function visitsForEach(): void {
  const entries = makeMap();
  const visited: Array<readonly [string, string]> = [];
  entries.set(KEY_BETA, VALUE_BETA);
  entries.set(KEY_GAMMA, VALUE_GAMMA);

  entries.forEach((value, key, map) => {
    expect(map).toBe(entries);
    visited.push([key, value]);
  });

  expect(visited).toEqual(FIFO_ENTRIES);
}

function rejectsInvalid(): void {
  for (const capacity of INVALID_CAPACITIES) {
    expect(() => new BoundedMap(capacity)).toThrow(INVALID_CAPACITY_MESSAGE);
  }
}

function makeMap(): BoundedMap<string, string> {
  return new BoundedMap<string, string>(CAPACITY);
}
