import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs");

import { resolveAuth } from "./config.js";

function mockConfigFile(config: object) {
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
}

describe("resolveAuth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MOLTZAP_API_KEY;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("MOLTZAP_API_KEY env var takes highest priority", () => {
    process.env.MOLTZAP_API_KEY = "moltzap_agent_envkey123";
    mockConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = resolveAuth();
    expect(result).toEqual({ agentKey: "moltzap_agent_envkey123" });
  });

  it("config apiKey is used when no env var", () => {
    mockConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = resolveAuth();
    expect(result).toEqual({ agentKey: "moltzap_agent_configkey" });
  });

  it("throws if no env var and no config apiKey", () => {
    mockConfigFile({ serverUrl: "wss://test" });

    expect(() => resolveAuth()).toThrow("No agent registered");
  });

  it("throws if config file missing", () => {
    // readFileSync throws ENOENT (set in beforeEach)
    expect(() => resolveAuth()).toThrow("No agent registered");
  });
});
