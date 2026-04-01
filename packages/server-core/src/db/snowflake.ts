/**
 * Application-level snowflake ID generator for message ordering.
 *
 * Generates monotonically increasing 52-bit IDs:
 *   timestamp_ms (42 bits) | counter (10 bits)
 *
 * 52 bits fits within Number.MAX_SAFE_INTEGER (2^53 - 1), so seq values
 * can be safely represented as JavaScript Numbers in JSON without precision loss.
 * ~1K IDs per ms, time-ordered, no DB lock contention. Safe until ~2106.
 */

let lastTimestamp = 0;
let counter = 0;

const COUNTER_BITS = 10;
const MAX_COUNTER = (1 << COUNTER_BITS) - 1; // 1023

export function nextSnowflakeId(): bigint {
  const now = Date.now();

  if (now === lastTimestamp) {
    counter++;
    if (counter > MAX_COUNTER) {
      while (Date.now() === lastTimestamp) {
        // spin until next ms
      }
      return nextSnowflakeId();
    }
  } else {
    lastTimestamp = now;
    counter = 0;
  }

  return (BigInt(now) << BigInt(COUNTER_BITS)) | BigInt(counter);
}

export function snowflakeToTimestamp(id: bigint): Date {
  return new Date(Number(id >> BigInt(COUNTER_BITS)));
}
