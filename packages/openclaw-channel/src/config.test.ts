import { describe, expect, it } from "vitest";
import { validateConfig, DEFAULT_SERVER_URL } from "./config.js";

describe("validateConfig", () => {
  const validConfig = {
    apiKey: "moltzap_agent_abc123",
    serverUrl: "wss://api.moltzap.xyz",
    agentName: "atlas",
  };

  it("returns config for valid input", () => {
    const result = validateConfig(validConfig);
    expect(result).toEqual(validConfig);
  });

  it("throws on missing apiKey", () => {
    expect(() =>
      validateConfig({ serverUrl: "wss://x", agentName: "a" }),
    ).toThrow("missing apiKey");
  });

  it("throws on empty apiKey", () => {
    expect(() =>
      validateConfig({ apiKey: "", serverUrl: "wss://x", agentName: "a" }),
    ).toThrow("missing apiKey");
  });

  it("throws on non-string apiKey", () => {
    expect(() =>
      validateConfig({ apiKey: 123, serverUrl: "wss://x", agentName: "a" }),
    ).toThrow("missing apiKey");
  });

  it("defaults serverUrl when missing", () => {
    const result = validateConfig({ apiKey: "k", agentName: "a" });
    expect(result.serverUrl).toBe(DEFAULT_SERVER_URL);
  });

  it("defaults serverUrl when empty", () => {
    const result = validateConfig({
      apiKey: "k",
      serverUrl: "",
      agentName: "a",
    });
    expect(result.serverUrl).toBe(DEFAULT_SERVER_URL);
  });

  it("throws on non-string serverUrl", () => {
    expect(() =>
      validateConfig({ apiKey: "k", serverUrl: true, agentName: "a" }),
    ).toThrow("serverUrl must be a string");
  });

  it("throws on missing agentName", () => {
    expect(() => validateConfig({ apiKey: "k", serverUrl: "wss://x" })).toThrow(
      "missing agentName",
    );
  });

  it("throws on empty agentName", () => {
    expect(() =>
      validateConfig({ apiKey: "k", serverUrl: "wss://x", agentName: "" }),
    ).toThrow("missing agentName");
  });

  it("throws on non-string agentName", () => {
    expect(() =>
      validateConfig({ apiKey: "k", serverUrl: "wss://x", agentName: 42 }),
    ).toThrow("missing agentName");
  });

  it("ignores extra fields", () => {
    const result = validateConfig({ ...validConfig, extra: "ignored" });
    expect(result).toEqual(validConfig);
  });
});
