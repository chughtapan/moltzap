/** @file Durable token minting bounds collision exhaustion with a persistence signal. */

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

    expect(() => mintDeliveryToken(isRetained)).toThrow(StoreSignal);
    expect(attempts).toBe(EXPECTED_COLLISION_ATTEMPTS);
    expect(() => mintDeliveryToken(() => true)).toThrow(
      new StoreSignal("persistence"),
    );
  });
});
