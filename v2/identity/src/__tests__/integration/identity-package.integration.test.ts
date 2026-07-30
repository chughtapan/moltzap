import { describe, expect, it } from "vitest";

describe("identity package build", () => {
  it("loads its built server entry", () =>
    expect(import("@moltzap/v2-identity/server")).resolves.toBeTypeOf(
      "object",
    ));
});
