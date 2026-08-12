import { describe, expect, it } from "vitest";
import { nextSnowflakeId } from "./snowflake.js";

const UNIQUE_ID_SAMPLE_SIZE = 1000;
const MONOTONIC_ID_SAMPLE_SIZE = 100;
const COUNTER_BITS = 10n;

describe("nextSnowflakeId", () => {
  it("generates unique IDs", () => {
    const ids = new Set<bigint>();
    for (let i = 0; i < UNIQUE_ID_SAMPLE_SIZE; i++) {
      ids.add(nextSnowflakeId());
    }
    expect(ids.size).toBe(UNIQUE_ID_SAMPLE_SIZE);
  });

  it("generates monotonically increasing IDs", () => {
    const ids: bigint[] = [];
    for (let i = 0; i < MONOTONIC_ID_SAMPLE_SIZE; i++) {
      ids.push(nextSnowflakeId());
    }
    for (let i = 1; i < ids.length; i++) {
      expect(
        /* Safe because the test fixture establishes this asserted shape. */ ids[
          i
        ]!,
      ).toBeGreaterThan(
        /* Safe because the test fixture establishes this asserted shape. */ ids[
          i - 1
        ]!,
      );
    }
  });

  it("encodes the timestamp in the high bits", () => {
    const before = Date.now();
    const id = nextSnowflakeId();
    const after = Date.now();
    const extracted = Number(id >> COUNTER_BITS);
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });
});
