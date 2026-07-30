/**
 * Unit tests for profile selection, profile coexistence, and no-persist mode.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import * as fc from "fast-check";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  emitNoPersist,
  loadLayeredConfig,
  parseProfileName,
  ProfileInvalidNameError,
  ProfileNotFoundError,
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
const ALICE_PROFILE_NAME =
  /* Safe because the test fixture establishes this asserted shape. */ "alice" as ProfileName;
const BOB_PROFILE_NAME =
  /* Safe because the test fixture establishes this asserted shape. */ "bob" as ProfileName;
const UNKNOWN_PROFILE_NAME = "nobody";

const DEFAULT_AGENT_NAME = "a";
const ALICE_AGENT_NAME = "alice";
const BOB_AGENT_NAME = "bob";
const DEFAULT_API_KEY = agentKeyString(20);
const ALICE_API_KEY = agentKeyString(22);
const BOB_API_KEY = agentKeyString(23);
const DEFAULT_AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440020");
const ALICE_AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440022");
const BOB_AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440023");
const BAD_PROFILE_NAME = "Bad";
const BAD_PROFILE_REASON = "upper";
const INVALID_JSON_TEXT = "{not json}";

const PROFILE_INVALID_NAME_ERROR = "ProfileInvalidNameError";
const PROFILE_CONFIG_READ_ERROR = "ProfileConfigReadError";

const writtenProfileRecordSchema = Schema.Struct({
  agentId: Schema.String,
  apiKey: Schema.String,
  agentName: Schema.String,
});
const writtenConfigSchema = Schema.Struct({
  profiles: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: writtenProfileRecordSchema,
    }),
  ),
});
type WrittenConfig = Schema.Schema.Type<typeof writtenConfigSchema>;
const writtenConfigTextSchema = Schema.parseJson(writtenConfigSchema);
const decodeWrittenConfigText = Schema.decodeUnknown(writtenConfigTextSchema);
const encodeWrittenConfigText = Schema.encodeSync(writtenConfigTextSchema);

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
  agentId: DEFAULT_AGENT_ID,
  apiKey: redactedAgentKey(apiKey),
  agentName: DEFAULT_AGENT_NAME,
});

const namedRecord = (apiKey: string, agentName: string): ProfileRecord => ({
  agentId: agentName === BOB_AGENT_NAME ? BOB_AGENT_ID : ALICE_AGENT_ID,
  apiKey: redactedAgentKey(apiKey),
  agentName,
});

const encodedNamedRecord = (apiKey: string, agentName: string) => ({
  agentId: agentName === BOB_AGENT_NAME ? BOB_AGENT_ID : ALICE_AGENT_ID,
  apiKey,
  agentName,
});

const namedProfilesConfig = () => ({
  profiles: {
    [ALICE_PROFILE_NAME]: encodedNamedRecord(ALICE_API_KEY, ALICE_AGENT_NAME),
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

const writeConfigObject = (config: WrittenConfig) =>
  writeConfigText(encodeWrittenConfigText(config));

const readConfigObject = (configHome: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem.readFileString(
      path.join(configHome, CONFIG_FILE_NAME),
      UTF8,
    );
    return yield* decodeWrittenConfigText(text);
  });

const expectProfiles = (
  profiles: WrittenConfig["profiles"],
): NonNullable<WrittenConfig["profiles"]> => {
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

function topLevelConfigFailsSchemaDecode() {
  return withNodeContext(
    Effect.gen(function* () {
      yield* writeConfigText(
        JSON.stringify({
          agentId: DEFAULT_AGENT_ID,
          apiKey: DEFAULT_API_KEY,
          agentName: DEFAULT_AGENT_NAME,
        }),
      );

      const exit = yield* Effect.exit(loadLayeredConfig);
      expectFailureContaining(exit, PROFILE_CONFIG_READ_ERROR);
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
        expect(record.agentId).toBe(ALICE_AGENT_ID);
        expect(Redacted.value(record.apiKey)).toBe(ALICE_API_KEY);
      }
    }),
  );
}

function profileNotFoundErrorCarriesName() {
  return Effect.sync(() => {
    const err = new ProfileNotFoundError({ name: UNKNOWN_PROFILE_NAME });
    expect(err.name).toBe(UNKNOWN_PROFILE_NAME);
  });
}

function writeNamedProfileCreatesProfilesOnlyConfig() {
  return withNodeContext(
    Effect.gen(function* () {
      const configHome = yield* writeConfigObject({});

      yield* writeProfile(
        ALICE_PROFILE_NAME,
        namedRecord(ALICE_API_KEY, ALICE_AGENT_NAME),
      );
      const written = yield* readConfigObject(configHome);
      const profiles = expectProfiles(written.profiles);
      expect(profiles[ALICE_PROFILE_NAME]?.agentId).toBe(ALICE_AGENT_ID);
      expect(profiles[ALICE_PROFILE_NAME]?.apiKey).toBe(ALICE_API_KEY);
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
      expect(profiles[ALICE_PROFILE_NAME]?.agentId).toBe(ALICE_AGENT_ID);
      expect(profiles[ALICE_PROFILE_NAME]?.apiKey).toBe(ALICE_API_KEY);
      expect(profiles[BOB_PROFILE_NAME]?.agentId).toBe(BOB_AGENT_ID);
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

describe("loadLayeredConfig top-level records", () => {
  it("top-level auth keys are rejected", topLevelConfigFailsSchemaDecode);
});

describe("loadLayeredConfig named profiles", () => {
  it("profiles object populates the profiles map", namedProfilesPopulateMap);
});

describe("ProfileNotFoundError", () => {
  it("carries the requested name", profileNotFoundErrorCarriesName);
});

describe("writeProfile", () => {
  it(
    "writing under a named profile creates a profiles-only config",
    writeNamedProfileCreatesProfilesOnlyConfig,
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
