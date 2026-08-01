import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  getMoltZapAgentServiceSocketPath,
  getMoltZapServiceSocketPath,
} from "../local-paths.js";
import {
  parseProfileName,
  type ProfileRecord,
  writeProfile,
} from "../profile.js";
import {
  makeTransportLayer,
  resolveTransportInputs,
  Transport,
  type TransportOptions,
} from "./transport.js";

const it = effectIt.scoped;

const TEST_SOCKET_PATH = "/var/run/moltzap-test.sock";
const PROFILE_NAME = "alice";
const PROFILE_AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440030");
const PROFILE_KEY = redactedAgentKey(agentKeyString(41));
const PROFILE_AGENT_NAME = "alice-agent";

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

const profileRecord: ProfileRecord = {
  agentId: PROFILE_AGENT_ID,
  apiKey: PROFILE_KEY,
  agentName: PROFILE_AGENT_NAME,
};

const makeConfigHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const configHome = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-cli-transport-",
  });
  vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);
});

const makeOpts = (over: Partial<TransportOptions> = {}): TransportOptions => ({
  socketPath: TEST_SOCKET_PATH,
  ...over,
});

function emptyInputUsesDefaultDaemonSocket() {
  return Effect.gen(function* () {
    const options = yield* resolveTransportInputs({});
    expect(options).toEqual({ socketPath: getMoltZapServiceSocketPath() });
  });
}

function profileInputUsesProfileAgentSocket() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* makeConfigHome;
      const profileName = yield* parseProfileName(PROFILE_NAME);
      yield* writeProfile(profileName, profileRecord);

      const options = yield* resolveTransportInputs({
        profileName,
      });

      expect(options).toEqual({
        socketPath: getMoltZapAgentServiceSocketPath(PROFILE_AGENT_ID),
      });
    }),
  );
}

function layerProvidesCommandTransport() {
  return Effect.gen(function* () {
    const command = yield* Transport.pipe(
      Effect.map((transport) => transport.command),
      Effect.provide(makeTransportLayer(makeOpts())),
    );

    expect(command).toEqual(expect.any(Function));
  });
}

describe("CLI daemon transport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "empty input uses the default daemon socket",
    emptyInputUsesDefaultDaemonSocket,
  );
  it(
    "profile input uses the profile agent socket",
    profileInputUsesProfileAgentSocket,
  );
  it("layer provides command transport", layerProvidesCommandTransport);
});
