import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Option, Redacted, Schema } from "effect";
import { AgentId, Register } from "@moltzap/protocol/identity";
import { AgentKey } from "@moltzap/protocol/identity";
import type { ResultOf } from "@moltzap/protocol/rpc";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { registerCommand } from "./register.js";
import { parseProfileName, type ProfileName } from "../../profile.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "config.json";
const AGENT_NAME = Effect.runSync(parseProfileName("my-agent"));
const INVITE_CODE = "inv_abc123";
const TEST_SERVER_URL = "wss://test.example";
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000123");
const API_KEY = redactedAgentKey(agentKeyString(11));

type RegisterResult = ResultOf<typeof Register>;

const MoltzapConfigText = Schema.parseJson(
  Schema.Struct({
    profiles: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        agentId: AgentId,
        apiKey: AgentKey,
        agentName: Schema.String,
      }),
    }),
  }),
);
const decodeMoltzapConfig = Schema.decodeUnknown(MoltzapConfigText);

const mockRegisterAgent =
  vi.fn<
    (
      baseUrl: string,
      name: string,
      opts?: { readonly inviteCode?: string; readonly description?: string },
    ) => Effect.Effect<RegisterResult>
  >();

vi.mock("../../auth.js", () => ({
  registerAgent: (
    baseUrl: string,
    name: string,
    opts?: { readonly inviteCode?: string; readonly description?: string },
  ) => {
    if (opts === undefined) return mockRegisterAgent(baseUrl, name);
    return mockRegisterAgent(baseUrl, name, opts);
  },
}));

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

function successfulRegistration(): Effect.Effect<RegisterResult> {
  return Effect.succeed({
    agentId: AGENT_ID,
    apiKey: API_KEY,
  });
}

const makeTempHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-register-home-",
  });
  const configHome = path.join(home, ".moltzap-config");
  vi.stubEnv("HOME", home);
  vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);
  vi.stubEnv("MOLTZAP_SERVER_URL", TEST_SERVER_URL);
  return { home, configHome };
});

function registerInput() {
  return {
    name: AGENT_NAME,
    inviteCode: INVITE_CODE,
    description: Option.none<string>(),
    profile: Option.none<ProfileName>(),
    noPersist: false,
  };
}

function persistsSharedProfileConfig() {
  return withNodeContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configHome } = yield* makeTempHome;

      yield* registerCommand.handler(registerInput());

      const moltzapConfig = yield* fileSystem
        .readFileString(path.join(configHome, CONFIG_FILE_NAME), "utf-8")
        .pipe(Effect.flatMap(decodeMoltzapConfig));
      const profile = moltzapConfig.profiles[AGENT_NAME];
      expect(profile).toBeDefined();
      expect(profile?.agentId).toBe(AGENT_ID);
      expect(Redacted.value(profile!.apiKey)).toBe(Redacted.value(API_KEY));
      expect(profile?.agentName).toBe(AGENT_NAME);
    }),
  );
}

describe("register command persistence", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mockRegisterAgent.mockImplementation(successfulRegistration);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes the shared client profile config", persistsSharedProfileConfig);
});
