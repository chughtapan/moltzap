import { describe, it, expect } from "vitest";
import { moltzapChannelPlugin } from "./openclaw-entry.js";

describe("isMoltZapTarget (via messaging.targetResolver.looksLikeId)", () => {
  const looksLikeId = moltzapChannelPlugin.messaging.targetResolver.looksLikeId;

  it("recognizes agent:<name>", () => {
    expect(looksLikeId("agent:bob")).toBe(true);
    expect(looksLikeId("agent:multi-word-name")).toBe(true);
  });

  it("recognizes conv:<id>", () => {
    expect(looksLikeId("conv:abc-123")).toBe(true);
    expect(looksLikeId("conv:a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
  });

  it("rejects plain strings", () => {
    expect(looksLikeId("plain-id")).toBe(false);
    expect(looksLikeId("")).toBe(false);
  });

  it("rejects unknown prefixes", () => {
    expect(looksLikeId("user:someone")).toBe(false);
    expect(looksLikeId("http://example.com")).toBe(false);
  });

  it("rejects empty identifier after prefix", () => {
    expect(looksLikeId("agent:")).toBe(false);
    expect(looksLikeId("conv:")).toBe(false);
  });
});

describe("messaging.targetResolver.resolveTarget", () => {
  const resolveTarget =
    moltzapChannelPlugin.messaging.targetResolver.resolveTarget;
  const cfg = {} as Parameters<typeof resolveTarget>[0]["cfg"];

  it("resolves agent:<name> as user target", async () => {
    const result = await resolveTarget({
      cfg,
      input: "agent:bob",
      normalized: "agent:bob",
    });
    expect(result).toEqual({
      to: "agent:bob",
      kind: "user",
      display: "bob",
      source: "normalized",
    });
  });

  it("resolves conv:<id> as group target", async () => {
    const result = await resolveTarget({
      cfg,
      input: "conv:abc-123",
      normalized: "conv:abc-123",
    });
    expect(result).toEqual({
      to: "conv:abc-123",
      kind: "group",
      display: "abc-123",
      source: "normalized",
    });
  });

  it("returns null for unrecognized formats", async () => {
    const result = await resolveTarget({
      cfg,
      input: "unknown",
      normalized: "unknown",
    });
    expect(result).toBeNull();
  });
});

describe("outbound.resolveTarget", () => {
  const resolveTarget = moltzapChannelPlugin.outbound.resolveTarget;

  it("accepts agent:<name>", () => {
    expect(resolveTarget({ to: "agent:bob" })).toEqual({
      ok: true,
      to: "agent:bob",
    });
  });

  it("accepts conv:<id>", () => {
    expect(resolveTarget({ to: "conv:abc" })).toEqual({
      ok: true,
      to: "conv:abc",
    });
  });

  it("accepts plain conversation ID (backward compat)", () => {
    expect(resolveTarget({ to: "plain-conv-id" })).toEqual({
      ok: true,
      to: "plain-conv-id",
    });
  });

  it("rejects empty target", () => {
    const result = resolveTarget({ to: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects undefined target", () => {
    const result = resolveTarget({});
    expect(result.ok).toBe(false);
  });

  it("rejects unknown prefix", () => {
    const result = resolveTarget({ to: "unknown:foo" });
    expect(result.ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(resolveTarget({ to: "  agent:bob  " })).toEqual({
      ok: true,
      to: "agent:bob",
    });
  });
});
