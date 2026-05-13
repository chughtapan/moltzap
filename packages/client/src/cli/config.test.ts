import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuth } from "./config.js";

const tempConfigHomes: string[] = [];

const makeConfigHome = (): string => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "moltzap-client-"));
  tempConfigHomes.push(configHome);
  process.env.MOLTZAP_CONFIG_HOME = configHome;
  return configHome;
};

const writeConfigFile = (config: object): void => {
  const configHome = makeConfigHome();
  fs.writeFileSync(
    path.join(configHome, "config.json"),
    JSON.stringify(config),
    "utf-8",
  );
};

describe("resolveAuth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MOLTZAP_API_KEY;
    delete process.env.MOLTZAP_SERVER_URL;
    delete process.env.MOLTZAP_CONFIG_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const configHome of tempConfigHomes.splice(0)) {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("MOLTZAP_API_KEY env var takes highest priority", async () => {
    process.env.MOLTZAP_API_KEY = "moltzap_agent_envkey123";
    writeConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = await Effect.runPromise(resolveAuth);
    expect(result).toEqual({ agentKey: "moltzap_agent_envkey123" });
  });

  it("config apiKey is used when no env var", async () => {
    writeConfigFile({
      serverUrl: "wss://test",
      apiKey: "moltzap_agent_configkey",
      agentName: "myagent",
    });

    const result = await Effect.runPromise(resolveAuth);
    expect(result).toEqual({ agentKey: "moltzap_agent_configkey" });
  });

  it("fails if no env var and no config apiKey", async () => {
    writeConfigFile({ serverUrl: "wss://test" });

    await expect(Effect.runPromise(resolveAuth)).rejects.toThrow(
      "No agent registered",
    );
  });

  it("fails if config file missing", async () => {
    makeConfigHome();

    await expect(Effect.runPromise(resolveAuth)).rejects.toThrow(
      "No agent registered",
    );
  });
});
