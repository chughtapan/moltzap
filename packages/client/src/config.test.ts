import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { AgentId } from "@moltzap/protocol/identity";
import { AgentKey } from "@moltzap/protocol/identity";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { loadServiceConfig } from "./config.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "config.json";
const CONFIG_HOME_PREFIX = "moltzap-client-";
const PROFILE_AGENT_KEY = agentKeyString(10);
const PROFILE_AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440029");
const TEST_PROFILE_NAME = "test-profile";
const TEST_PROFILE_AGENT_NAME = "profile-agent";
const TEST_SERVER_URL = "wss://test.moltzap.local";
const MISSING_API_KEY_MESSAGE = "missing an apiKey";
const PROFILE_NOT_FOUND_ERROR = "ProfileNotFoundError";

const ConfigFixtureSchema = Schema.parseJson(
  Schema.Struct({
    profiles: Schema.optional(
      Schema.Record({
        key: Schema.String,
        value: Schema.Struct({
          agentId: AgentId,
          apiKey: Schema.optional(AgentKey),
          agentName: Schema.String,
        }),
      }),
    ),
  }),
);
type ConfigFixture = Schema.Schema.Type<typeof ConfigFixtureSchema>;
const encodeConfigFixture = Schema.encodeSync(ConfigFixtureSchema);

const profileAuthConfig = (): ConfigFixture => ({
  profiles: {
    [TEST_PROFILE_NAME]: {
      agentId: PROFILE_AGENT_ID,
      apiKey: redactedAgentKey(PROFILE_AGENT_KEY),
      agentName: TEST_PROFILE_AGENT_NAME,
    },
  },
});

const profileWithoutCredentialConfig = (): ConfigFixture => ({
  profiles: {
    [TEST_PROFILE_NAME]: {
      agentId: PROFILE_AGENT_ID,
      agentName: TEST_PROFILE_AGENT_NAME,
    },
  },
});

const makeConfigHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const configHome = yield* fileSystem.makeTempDirectoryScoped({
    prefix: CONFIG_HOME_PREFIX,
  });
  vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);
  return configHome;
});

const writeConfigFile = (config: ConfigFixture) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configHome = yield* makeConfigHome;
    yield* fileSystem.writeFileString(
      path.join(configHome, CONFIG_FILE_NAME),
      encodeConfigFixture(config),
    );
  });

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

function serviceConfigIncludesServerUrl() {
  return withNodeContext(
    Effect.gen(function* () {
      vi.stubEnv("MOLTZAP_SERVER_URL", TEST_SERVER_URL);
      yield* writeConfigFile(profileAuthConfig());

      const result = yield* loadServiceConfig(TEST_PROFILE_NAME);
      expect(result.serverUrl).toBe(TEST_SERVER_URL);
      expect(Redacted.value(result.agentKey)).toBe(PROFILE_AGENT_KEY);
      expect(result.agentId).toBe(PROFILE_AGENT_ID);
    }),
  );
}

function missingProfileFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* makeConfigHome;

      const exit = yield* Effect.exit(loadServiceConfig(TEST_PROFILE_NAME));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(PROFILE_NOT_FOUND_ERROR);
    }),
  );
}

function profileWithoutApiKeyFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigFile(profileWithoutCredentialConfig());

      const exit = yield* Effect.exit(loadServiceConfig(TEST_PROFILE_NAME));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(MISSING_API_KEY_MESSAGE);
    }),
  );
}

describe("loadServiceConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "loads credentials and server URL for MoltZapService",
    serviceConfigIncludesServerUrl,
  );

  it("fails when the named profile does not exist", missingProfileFails);

  it("fails when the named profile has no apiKey", profileWithoutApiKeyFails);
});
