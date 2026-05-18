/**
 * Unit tests for the profile layer. Spec items Section 5.2 (`--profile`,
 * `--no-persist`), Invariants 4.3 (coexistence), 4.4 (no-disk-write).
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  emitNoPersist,
  loadLayeredConfig,
  parseProfileName,
  ProfileInvalidNameError,
  ProfileNotFoundError,
  resolveProfileAuth,
  writeProfile,
  type ProfileName,
  type ProfileRecord,
} from "./profile.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "config.json";
const CONFIG_HOME_PREFIX = "moltzap-profile-";
const UTF8 = "utf-8";
const EMPTY_PROFILE_COUNT = 0;
const SINGLE_PROFILE_COUNT = 1;

const VALID_PROFILE_NAME = "alice-bot";
const ALICE_PROFILE_NAME = "alice" as ProfileName;
const BOB_PROFILE_NAME = "bob" as ProfileName;
const UNKNOWN_PROFILE_NAME = "nobody";
const GHOST_PROFILE_NAME = "ghost" as ProfileName;
const DEFAULT_PROFILE_NAME = "default";

const TEST_SERVER_URL = "wss://x";
const DEFAULT_AGENT_NAME = "a";
const LEGACY_AGENT_NAME = "legacy";
const ALICE_AGENT_NAME = "alice";
const BOB_AGENT_NAME = "bob";
const DEFAULT_API_KEY = "k";
const LEGACY_API_KEY = "legacy-key";
const ALICE_API_KEY = "k-alice";
const BOB_API_KEY = "k-bob";
const BAD_PROFILE_NAME = "Bad";
const BAD_PROFILE_REASON = "upper";
const INVALID_JSON_TEXT = "{not json}";

const PROFILE_INVALID_NAME_ERROR = "ProfileInvalidNameError";
const PROFILE_CONFIG_READ_ERROR = "ProfileConfigReadError";
const PROFILE_NOT_FOUND_ERROR = "ProfileNotFoundError";

const WrittenProfileRecordSchema = Schema.Struct({
  apiKey: Schema.String,
  agentName: Schema.String,
  serverUrl: Schema.String,
  registeredAt: Schema.optional(Schema.String),
});
const WrittenConfigSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  profiles: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: WrittenProfileRecordSchema,
    }),
  ),
});
type WrittenConfig = Schema.Schema.Type<typeof WrittenConfigSchema>;
const decodeWrittenConfig = Schema.decodeUnknown(WrittenConfigSchema);

const profileNameArbitrary = fc.stringMatching(
  /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/,
);

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const withNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeContext.layer));

const defaultRecord = (apiKey: string = DEFAULT_API_KEY): ProfileRecord => ({
  apiKey,
  agentName: DEFAULT_AGENT_NAME,
  serverUrl: TEST_SERVER_URL,
});

const namedRecord = (apiKey: string, agentName: string): ProfileRecord => ({
  apiKey,
  agentName,
  serverUrl: TEST_SERVER_URL,
});

const legacyConfig = (apiKey: string = DEFAULT_API_KEY) => ({
  serverUrl: TEST_SERVER_URL,
  apiKey,
  agentName: DEFAULT_AGENT_NAME,
});

const namedProfilesConfig = () => ({
  serverUrl: TEST_SERVER_URL,
  profiles: {
    [ALICE_PROFILE_NAME]: namedRecord(ALICE_API_KEY, ALICE_AGENT_NAME),
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

const writeConfigText = (text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configHome = yield* makeConfigHome;
    yield* fileSystem.writeFileString(
      path.join(configHome, CONFIG_FILE_NAME),
      text,
    );
    return configHome;
  });

const writeConfigObject = (config: object) =>
  writeConfigText(JSON.stringify(config));

const readConfigObject = (configHome: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem.readFileString(
      path.join(configHome, CONFIG_FILE_NAME),
      UTF8,
    );
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => error,
    });
    return yield* decodeWrittenConfig(parsed);
  });

const expectProfiles = (
  profiles: WrittenConfig["profiles"],
): Record<string, ProfileRecord> => {
  expect(profiles).toBeDefined();
  return profiles ?? {};
};

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
};

const expectFailureContaining = <A, E>(
  exit: Exit.Exit<A, E>,
  marker: string,
): void => {
  expectFailure(exit);
  expect(String(exit)).toContain(marker);
};

function expectGeneratedProfileNameParses(raw: string): void {
  const exit = Effect.runSyncExit(parseProfileName(raw));
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value).toBe(raw);
  }
}

function parsesLowercaseAlphanumericName() {
  return Effect.gen(function* () {
    const name = yield* parseProfileName(VALID_PROFILE_NAME);
    expect(name).toBe(VALID_PROFILE_NAME);
  });
}

function generatedValidProfileNamesParse() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(profileNameArbitrary, expectGeneratedProfileNameParses),
    );
  });
}

function rejectsEmptyName() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(parseProfileName(""));
    expectFailure(exit);
  });
}

function rejectsUppercaseName() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(parseProfileName(BAD_PROFILE_NAME));
    expectFailure(exit);
  });
}

function rejectsLeadingHyphen() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(parseProfileName("-alice"));
    expectFailure(exit);
  });
}

function rejectsTrailingHyphen() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(parseProfileName("alice-"));
    expectFailure(exit);
  });
}

function invalidNameErrorTypeSurfaces() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(parseProfileName(""));
    expectFailureContaining(exit, PROFILE_INVALID_NAME_ERROR);
  });
}

function missingFileLoadsEmptyView() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* makeConfigHome;

      const view = yield* loadLayeredConfig;
      expect(view.default).toBeUndefined();
      expect(view.profiles.size).toBe(EMPTY_PROFILE_COUNT);
    }),
  );
}

function malformedConfigFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigText(INVALID_JSON_TEXT);

      const exit = yield* Effect.exit(loadLayeredConfig);
      expectFailureContaining(exit, PROFILE_CONFIG_READ_ERROR);
    }),
  );
}

function legacyConfigPopulatesDefaultRecord() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject(legacyConfig());

      const view = yield* loadLayeredConfig;
      const record = view.default;
      expect(record).toBeDefined();
      if (record !== undefined) {
        expect(record.apiKey).toBe(DEFAULT_API_KEY);
        expect(record.agentName).toBe(DEFAULT_AGENT_NAME);
      }
      expect(view.serverUrl).toBe(TEST_SERVER_URL);
    }),
  );
}

function unknownTopLevelKeysAreTolerated() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject({
        ...legacyConfig(),
        futureExperimentalField: { nested: true },
      });

      const view = yield* loadLayeredConfig;
      const record = view.default;
      expect(record).toBeDefined();
      if (record !== undefined) {
        expect(record.apiKey).toBe(DEFAULT_API_KEY);
      }
    }),
  );
}

function namedProfilesPopulateMap() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject(namedProfilesConfig());

      const view = yield* loadLayeredConfig;
      expect(view.profiles.size).toBe(SINGLE_PROFILE_COUNT);
      const record = view.profiles.get(ALICE_PROFILE_NAME);
      expect(record).toBeDefined();
      if (record !== undefined) {
        expect(record.apiKey).toBe(ALICE_API_KEY);
      }
    }),
  );
}

function legacyProfileWithoutRegisteredAtDecodes() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject({
        serverUrl: TEST_SERVER_URL,
        profiles: {
          [BOB_PROFILE_NAME]: namedRecord(BOB_API_KEY, BOB_AGENT_NAME),
        },
      });

      const view = yield* loadLayeredConfig;
      const record = view.profiles.get(BOB_PROFILE_NAME);
      expect(record).toBeDefined();
      if (record !== undefined) {
        expect(record.registeredAt).toBeUndefined();
      }
    }),
  );
}

function defaultProfileAuthResolves() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject(legacyConfig());

      const record = yield* resolveProfileAuth(undefined);
      expect(record.apiKey).toBe(DEFAULT_API_KEY);
    }),
  );
}

function unknownProfileFails() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject(legacyConfig());

      const exit = yield* Effect.exit(resolveProfileAuth(GHOST_PROFILE_NAME));
      expectFailureContaining(exit, PROFILE_NOT_FOUND_ERROR);
    }),
  );
}

function namedProfileAuthResolves() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigObject(namedProfilesConfig());

      const record = yield* resolveProfileAuth(ALICE_PROFILE_NAME);
      expect(record.apiKey).toBe(ALICE_API_KEY);
    }),
  );
}

function profileNotFoundErrorCarriesName() {
  return Effect.sync(() => {
    const err = new ProfileNotFoundError({ name: UNKNOWN_PROFILE_NAME });
    expect(err.name).toBe(UNKNOWN_PROFILE_NAME);
  });
}

function writeNamedProfilePreservesLegacyTopLevelKeys() {
  return withNodeContext(
    Effect.gen(function* () {
      const configHome = yield* writeConfigObject({
        serverUrl: TEST_SERVER_URL,
        apiKey: LEGACY_API_KEY,
        agentName: LEGACY_AGENT_NAME,
      });

      yield* writeProfile(
        ALICE_PROFILE_NAME,
        namedRecord(ALICE_API_KEY, ALICE_AGENT_NAME),
      );
      const written = yield* readConfigObject(configHome);
      const profiles = expectProfiles(written.profiles);
      expect(written.apiKey).toBe(LEGACY_API_KEY);
      expect(profiles[ALICE_PROFILE_NAME]?.apiKey).toBe(ALICE_API_KEY);
    }),
  );
}

function writeDefaultProfileUpdatesTopLevelKeys() {
  return withNodeContext(
    Effect.gen(function* () {
      const configHome = yield* makeConfigHome;

      yield* writeProfile(DEFAULT_PROFILE_NAME, defaultRecord());
      const written = yield* readConfigObject(configHome);
      expect(written.apiKey).toBe(DEFAULT_API_KEY);
      expect(written.profiles).toBeUndefined();
    }),
  );
}

function writeSecondProfilePreservesFirst() {
  return withNodeContext(
    Effect.gen(function* () {
      const configHome = yield* writeConfigObject(namedProfilesConfig());

      yield* writeProfile(
        BOB_PROFILE_NAME,
        namedRecord(BOB_API_KEY, BOB_AGENT_NAME),
      );
      const written = yield* readConfigObject(configHome);
      const profiles = expectProfiles(written.profiles);
      expect(profiles[ALICE_PROFILE_NAME]?.apiKey).toBe(ALICE_API_KEY);
      expect(profiles[BOB_PROFILE_NAME]?.apiKey).toBe(BOB_API_KEY);
    }),
  );
}

function emitNoPersistLeavesConfigDirUnchanged() {
  return withNodeContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configHome = yield* makeConfigHome;
      const before = yield* fileSystem.readDirectory(configHome);

      yield* emitNoPersist(defaultRecord());
      const after = yield* fileSystem.readDirectory(configHome);
      expect(after).toEqual(before);
    }),
  );
}

function emitNoPersistReturnsRecord() {
  return Effect.gen(function* () {
    const record = defaultRecord();
    const result = yield* emitNoPersist(record);
    expect(result.record).toEqual(record);
  });
}

function profileInvalidNameErrorCarriesFields() {
  return Effect.sync(() => {
    const err = new ProfileInvalidNameError({
      name: BAD_PROFILE_NAME,
      reason: BAD_PROFILE_REASON,
    });
    expect(err.name).toBe(BAD_PROFILE_NAME);
    expect(err.reason).toBe(BAD_PROFILE_REASON);
  });
}

describe("parseProfileName valid input", () => {
  it(
    "accepts a valid lowercase-alphanumeric name",
    parsesLowercaseAlphanumericName,
  );

  it("accepts generated valid profile names", generatedValidProfileNamesParse);
});

describe("parseProfileName invalid input", () => {
  it("rejects an empty string with ProfileInvalidNameError", rejectsEmptyName);

  it("rejects a name with uppercase letters", rejectsUppercaseName);

  it("rejects a name starting with a hyphen", rejectsLeadingHyphen);
});

describe("parseProfileName invalid boundary input", () => {
  it("rejects a name ending with a hyphen", rejectsTrailingHyphen);

  it("fails with ProfileInvalidNameError type", invalidNameErrorTypeSurfaces);
});

describe("loadLayeredConfig missing and malformed input", () => {
  it("missing file resolves with empty view", missingFileLoadsEmptyView);

  it("parse error surfaces as ProfileConfigReadError", malformedConfigFails);
});

describe("loadLayeredConfig legacy records", () => {
  it(
    "legacy top-level auth populates default",
    legacyConfigPopulatesDefaultRecord,
  );

  it("tolerates unknown top-level keys", unknownTopLevelKeysAreTolerated);
});

describe("loadLayeredConfig named profiles", () => {
  it("profiles object populates the profiles map", namedProfilesPopulateMap);

  it(
    "missing registeredAt on legacy-shaped profile still decodes",
    legacyProfileWithoutRegisteredAtDecodes,
  );
});

describe("resolveProfileAuth", () => {
  it("undefined name returns the default record", defaultProfileAuthResolves);

  it("unknown name returns ProfileNotFoundError", unknownProfileFails);

  it("known name returns the named record", namedProfileAuthResolves);
});

describe("ProfileNotFoundError", () => {
  it("carries the requested name", profileNotFoundErrorCarriesName);
});

describe("writeProfile", () => {
  it(
    "writing under a named profile leaves top-level apiKey untouched",
    writeNamedProfilePreservesLegacyTopLevelKeys,
  );

  it(
    "writing default updates top-level keys",
    writeDefaultProfileUpdatesTopLevelKeys,
  );

  it(
    "adding a second profile preserves the first",
    writeSecondProfilePreservesFirst,
  );
});

describe("emitNoPersist", () => {
  it(
    "never writes to the moltzap config directory",
    emitNoPersistLeavesConfigDirUnchanged,
  );

  it(
    "returns the record unchanged for the caller to print",
    emitNoPersistReturnsRecord,
  );
});

describe("ProfileInvalidNameError", () => {
  it("carries name and reason", profileInvalidNameErrorCarriesFields);
});
