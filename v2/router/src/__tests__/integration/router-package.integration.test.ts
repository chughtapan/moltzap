import { describe, expect, it } from "vitest";

describe("Router package build", () => {
  it("loads its built server entry", () =>
    expect(import("@moltzap/v2-router/server")).resolves.toBeTypeOf("object"));
});
