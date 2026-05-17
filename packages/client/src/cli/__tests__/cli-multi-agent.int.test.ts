import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  emitNoPersist,
  parseProfileName,
  writeProfile,
  type ProfileRecord,
} from "../profile.js";
import {
  decideTransport,
  DIRECT_TRANSPORT_KIND,
  makeTransportLayer,
  resolveTransportInputs,
  Transport,
} from "../transport.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "config.json";
const ALICE_PROFILE_NAME = "alice";
const MISSING_PROFILE_NAME = "missing-profile";
const ALICE_KEY = "key-alice";
const BOB_KEY = "key-bob";
const SERVER_URL = "wss://multi-agent.example";
const ALICE_AGENT = "alice-agent";
const INVALID_CONFIG_TEXT = "{not valid json}";
const MOLTZAP_DIR_NAME = ".moltzap";
const OPENCLAW_DIR_NAME = ".openclaw";

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

const profileRecord = (apiKey: string, agentName: string): ProfileRecord => ({
  apiKey,
  agentName,
  serverUrl: SERVER_URL,
});

const makeConfigHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const configHome = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-cli-config-",
  });
  vi.stubEnv("MOLTZAP_CONFIG_HOME", configHome);
  return configHome;
});

const makeHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-cli-home-",
  });
  vi.stubEnv("HOME", home);
  return home;
});

function namedProfileResolvesToDirectTransport() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* makeConfigHome;
      const name = yield* parseProfileName(ALICE_PROFILE_NAME);
      yield* writeProfile(name, profileRecord(ALICE_KEY, ALICE_AGENT));

      const options = yield* resolveTransportInputs({
        profileName: ALICE_PROFILE_NAME,
      });
      const decision = yield* decideTransport(options);

      expect(options.profileKey).toBe(ALICE_KEY);
      expect(options.serverUrl).toBe(SERVER_URL);
      expect(decision).toEqual({ _tag: "UseDirect", reason: "profile" });
    }),
  );
}

function noPersistLeavesConfigTreesUntouched() {
  return withNodeContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      const moltzapDir = path.join(home, MOLTZAP_DIR_NAME);
      const openclawDir = path.join(home, OPENCLAW_DIR_NAME);

      yield* emitNoPersist(profileRecord(ALICE_KEY, ALICE_AGENT));

      expect(yield* fileSystem.exists(moltzapDir)).toBe(false);
      expect(yield* fileSystem.exists(openclawDir)).toBe(false);
    }),
  );
}

function asFlagWinsOverProfileWithoutReadingConfig() {
  return withNodeContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configHome = yield* makeConfigHome;
      yield* fileSystem.writeFileString(
        path.join(configHome, CONFIG_FILE_NAME),
        INVALID_CONFIG_TEXT,
      );
      vi.stubEnv("MOLTZAP_SERVER_URL", SERVER_URL);

      const options = yield* resolveTransportInputs({
        impersonateKey: ALICE_KEY,
        profileName: MISSING_PROFILE_NAME,
      });
      const decision = yield* decideTransport(options);

      expect(options.impersonateKey).toBe(ALICE_KEY);
      expect(options.profileKey).toBeUndefined();
      expect(options.serverUrl).toBe(SERVER_URL);
      expect(decision).toEqual({ _tag: "UseDirect", reason: "as-flag" });
    }),
  );
}

function concurrentAsResolutionsKeepDistinctCredentials() {
  return withNodeContext(
    Effect.gen(function* () {
      const [alice, bob] = yield* Effect.all(
        [
          resolveTransportInputs({ impersonateKey: ALICE_KEY }),
          resolveTransportInputs({ impersonateKey: BOB_KEY }),
        ],
        { concurrency: 2 },
      );

      expect(alice.impersonateKey).toBe(ALICE_KEY);
      expect(bob.impersonateKey).toBe(BOB_KEY);
      expect(alice.impersonateKey).not.toBe(bob.impersonateKey);
    }),
  );
}

function asInvocationDoesNotConfigureDaemonProbe() {
  return withNodeContext(
    Effect.gen(function* () {
      const options = yield* resolveTransportInputs({
        impersonateKey: ALICE_KEY,
      });

      expect(options.socketPath).toBeUndefined();
      expect(options.probeDaemon).toBeUndefined();
      expect(yield* decideTransport(options)).toEqual({
        _tag: "UseDirect",
        reason: "as-flag",
      });
    }),
  );
}

function resolvedAsLayerProvidesDirectTransport() {
  return withNodeContext(
    Effect.gen(function* () {
      const options = yield* resolveTransportInputs({
        impersonateKey: BOB_KEY,
      });
      const kind = yield* Transport.pipe(
        Effect.map((transport) => transport.kind),
        Effect.provide(makeTransportLayer(options)),
      );

      expect(kind).toBe(DIRECT_TRANSPORT_KIND);
    }),
  );
}

describe("multi-agent CLI roster (--as + --profile)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "resolves an existing named profile to direct transport credentials",
    namedProfileResolvesToDirectTransport,
  );

  it(
    "--no-persist leaves both config trees untouched",
    noPersistLeavesConfigTreesUntouched,
  );

  it(
    "--as wins over --profile without reading malformed profile config",
    asFlagWinsOverProfileWithoutReadingConfig,
  );

  it(
    "two concurrent --as resolutions preserve distinct agent credentials",
    concurrentAsResolutionsKeepDistinctCredentials,
  );

  it(
    "--as invocation does not configure a singleton daemon probe",
    asInvocationDoesNotConfigureDaemonProbe,
  );

  it(
    "resolved --as transport layer provides the direct transport",
    resolvedAsLayerProvidesDirectTransport,
  );
});
