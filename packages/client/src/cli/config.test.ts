import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { resolveAuth } from "./config.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "config.json";
const CONFIG_HOME_PREFIX = "moltzap-client-";
const ENV_AGENT_KEY = "moltzap_agent_envkey123";
const CONFIG_AGENT_KEY = "moltzap_agent_configkey";
const TEST_SERVER_URL = "wss://test";
const TEST_AGENT_NAME = "myagent";
const MISSING_REGISTRATION_MESSAGE = "No agent registered";

const apiKeyArbitrary = fc.stringMatching(/^moltzap_agent_[a-z0-9]{1,16}$/);

const authConfig = (apiKey: string): Record<string, string> => ({
  serverUrl: TEST_SERVER_URL,
  apiKey,
  agentName: TEST_AGENT_NAME,
});

const makeConfigHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const configHome = yield* fileSystem.makeTempDirectoryScoped({
    prefix: CONFIG_HOME_PREFIX,
  });
  vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);
  return configHome;
});

const writeConfigFile = (config: object) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configHome = yield* makeConfigHome;
    yield* fileSystem.writeFileString(
      path.join(configHome, CONFIG_FILE_NAME),
      JSON.stringify(config),
    );
  });

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

function expectAuthConfigPreservesKey(apiKey: string): void {
  expect(authConfig(apiKey).apiKey).toBe(apiKey);
}

function authConfigPreservesGeneratedKeys() {
  return Effect.sync(() => {
    fc.assert(fc.property(apiKeyArbitrary, expectAuthConfigPreservesKey));
  });
}

function envApiKeyTakesPriority() {
  return withNodeContext(
    Effect.gen(function* () {
      vi.stubEnv("MOLTZAP_API_KEY", ENV_AGENT_KEY);
      yield* writeConfigFile(authConfig(CONFIG_AGENT_KEY));

      const result = yield* resolveAuth;
      expect(result).toEqual({ agentKey: ENV_AGENT_KEY });
    }),
  );
}

function configApiKeyIsUsed() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigFile(authConfig(CONFIG_AGENT_KEY));

      const result = yield* resolveAuth;
      expect(result).toEqual({ agentKey: CONFIG_AGENT_KEY });
    }),
  );
}

function missingConfigApiKeyFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigFile({ serverUrl: TEST_SERVER_URL });

      const exit = yield* Effect.exit(resolveAuth);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(MISSING_REGISTRATION_MESSAGE);
    }),
  );
}

function missingConfigFileFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* makeConfigHome;

      const exit = yield* Effect.exit(resolveAuth);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(MISSING_REGISTRATION_MESSAGE);
    }),
  );
}

describe("resolveAuth", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "auth config fixture preserves generated api keys",
    authConfigPreservesGeneratedKeys,
  );

  it("MOLTZAP_API_KEY env var takes highest priority", envApiKeyTakesPriority);

  it("config apiKey is used when no env var", configApiKeyIsUsed);

  it("fails if no env var and no config apiKey", missingConfigApiKeyFails);

  it("fails if config file missing", missingConfigFileFails);
});
