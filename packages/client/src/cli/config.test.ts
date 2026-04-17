import * as fs from "node:fs";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    delete process.env.MOLTZAP_SERVER_URL;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("MOLTZAP_API_KEY env var takes highest priority", async () => {
    process.env.MOLTZAP_API_KEY = "moltzap_agent_envkey123";
    mockConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = await Effect.runPromise(resolveAuth);
    expect(result).toEqual({ agentKey: "moltzap_agent_envkey123" });
  });

  it("config apiKey is used when no env var", async () => {
    mockConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = await Effect.runPromise(resolveAuth);
    expect(result).toEqual({ agentKey: "moltzap_agent_configkey" });
  });

  it("fails if no env var and no config apiKey", async () => {
    mockConfigFile({ serverUrl: "wss://test" });

    await expect(Effect.runPromise(resolveAuth)).rejects.toThrow(
      "No agent registered",
    );
  });

  it("fails if config file missing", async () => {
    // readFileSync throws ENOENT (set in beforeEach)
    await expect(Effect.runPromise(resolveAuth)).rejects.toThrow(
      "No agent registered",
    );
  });
});
