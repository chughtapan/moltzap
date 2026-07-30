import { describe, expect, it } from "vitest";

describe("Router package", () => {
  it("loads its built public entry", () =>
    expect(import("@moltzap/v2-router")).resolves.toBeTypeOf("object"));
});
