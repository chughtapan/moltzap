import { describe, expect, it } from "vitest";
import { nextSnowflakeId, snowflakeToTimestamp } from "./snowflake.js";

describe("nextSnowflakeId", () => {
  it("generates unique IDs", () => {
    const ids = new Set<bigint>();
    for (let i = 0; i < 1000; i++) {
      ids.add(nextSnowflakeId());
    }
    expect(ids.size).toBe(1000);
  });

  it("generates monotonically increasing IDs", () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(nextSnowflakeId());
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it("roundtrips timestamp extraction", () => {
    const before = Date.now();
    const id = nextSnowflakeId();
    const after = Date.now();
    const extracted = snowflakeToTimestamp(id).getTime();
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });
});
