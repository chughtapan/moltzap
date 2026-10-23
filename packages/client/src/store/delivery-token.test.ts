/** @file Durable token minting bounds collision exhaustion with a persistence signal. */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { mintDeliveryToken, StoreSignal } from "./database/index.js";

const EXPECTED_COLLISION_ATTEMPTS = 8;

describe("delivery token minting", () => {
  it("fails with persistence after exactly eight retained candidates", () => {
    let attempts = 0;
    const isRetained = () => {
      attempts += 1;
      return true;
    };

    const failure = Effect.runSync(
      Effect.flip(Effect.try(() => mintDeliveryToken(isRetained))),
    );
    expect(failure.error).toBeInstanceOf(StoreSignal);
    expect(failure.error).toMatchObject({ reason: "persistence" });
    expect(attempts).toBe(EXPECTED_COLLISION_ATTEMPTS);
  });
});
