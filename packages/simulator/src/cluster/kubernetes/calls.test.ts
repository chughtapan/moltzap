import { describe, expect, it } from "vitest";
import { currentConditionIsTrue } from "./calls.js";

describe("currentConditionIsTrue", () => {
  it("accepts only a positive condition for the current object generation", () => {
    expect(
      currentConditionIsTrue(
        {
          metadata: { generation: 4 },
          status: {
            conditions: [
              { type: "Ready", status: "True", observedGeneration: 3 },
              { type: "Admitted", status: "True", observedGeneration: 4 },
            ],
          },
        },
        "Admitted",
      ),
    ).toBe(true);
  });

  it("rejects stale, false, and absent conditions", () => {
    expect(
      currentConditionIsTrue(
        {
          metadata: { generation: 4 },
          status: {
            conditions: [
              { type: "Admitted", status: "True", observedGeneration: 3 },
              { type: "Ready", status: "False", observedGeneration: 4 },
            ],
          },
        },
        "Admitted",
      ),
    ).toBe(false);
    expect(
      currentConditionIsTrue({ metadata: { generation: 1 } }, "Ready"),
    ).toBe(false);
  });
});
