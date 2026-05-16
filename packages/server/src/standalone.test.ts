import type { AppManifest } from "@moltzap/protocol";
import * as fc from "fast-check";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeAppManifest, InvalidAppManifest } from "./standalone.js";

const APP_ID = "werewolf";
const APP_NAME = "Werewolf";
const DESCRIPTION = "Social deduction";
const TOWN_SQUARE_KEY = "town_square";
const TOWN_SQUARE_NAME = "Town Square";
const ALL_PARTICIPANTS = "all";
const VALID_MANIFEST_PATH = "/path/to/werewolf.json";
const BROKEN_MANIFEST_PATH = "/path/to/broken.json";
const MISSING_NAME_PATH = "/path/to/missing-name.json";
const EXTRA_FIELD_PATH = "/path/to/extra-field.json";
const LEGACY_PERMISSIONS_PATH = "/path/to/legacy-permissions.json";
const WRONG_TYPE_PATH = "/path/to/wrong-type.json";
const MALFORMED_JSON = "{ not valid json";
const PARSE_KIND = "parse";
const SCHEMA_KIND = "schema";
const UNEXPECTED_VALUE = "nope";
const TEST_NAME = "Test";
const PROPERTY_RUNS = 25;
const MAX_PARTICIPANTS = 12;
const DISPATCH_AUTHORIZE_TIMEOUT_MS = 5_000;

const VALID_MANIFEST = {
  appId: APP_ID,
  name: APP_NAME,
} satisfies AppManifest;

const MINIMAL_MANIFESTS = fc.record({
  appId: fc.string(),
  name: fc.string(),
});

describe("decodeAppManifest valid manifests", () => {
  const minimalManifestProperty = fc.property(
    MINIMAL_MANIFESTS,
    assertMinimalManifestRoundTrip,
  );

  it("returns Right(manifest) for a valid manifest JSON", () => {
    const manifest = expectDecodedManifest(
      decodeAppManifest(JSON.stringify(VALID_MANIFEST), VALID_MANIFEST_PATH),
    );
    expect(manifest?.appId).toBe(APP_ID);
    expect(manifest?.name).toBe(APP_NAME);
  });

  it("property: minimal manifests round-trip through the decoder", () => {
    expect.hasAssertions();
    fc.assert(minimalManifestProperty, { numRuns: PROPERTY_RUNS });
  });

  it("accepts a full manifest with optional fields", () => {
    const manifest = expectDecodedManifest(
      decodeAppManifest(JSON.stringify(fullManifest()), VALID_MANIFEST_PATH),
    );
    expect(manifest).toBeDefined();
  });
});

describe("decodeAppManifest parse errors", () => {
  it("returns Left(InvalidAppManifest, kind=parse) for malformed JSON", () => {
    const error = expectManifestError(
      decodeAppManifest(MALFORMED_JSON, BROKEN_MANIFEST_PATH),
    );
    expect(error).toBeInstanceOf(InvalidAppManifest);
    expect(error?.kind).toBe(PARSE_KIND);
    expect(error?.path).toBe(BROKEN_MANIFEST_PATH);
    expect(error?.errors.length).toBeGreaterThan(0);
  });
});

describe("decodeAppManifest required schema errors", () => {
  it("returns Left(kind=schema) when required fields are missing", () => {
    const error = expectManifestError(
      decodeAppManifest(JSON.stringify({ appId: APP_ID }), MISSING_NAME_PATH),
    );
    expect(error).toBeInstanceOf(InvalidAppManifest);
    expect(error?.kind).toBe(SCHEMA_KIND);
    expect(error?.path).toBe(MISSING_NAME_PATH);
    expect(error?.errors.length).toBeGreaterThan(0);
  });
});

describe("decodeAppManifest closed schema errors", () => {
  it("returns Left(kind=schema) on additional properties", () => {
    const error = expectManifestError(
      decodeAppManifest(
        JSON.stringify({ ...VALID_MANIFEST, unexpected: UNEXPECTED_VALUE }),
        EXTRA_FIELD_PATH,
      ),
    );
    expect(error?.kind).toBe(SCHEMA_KIND);
  });

  it("returns Left(kind=schema) on retired permissions field", () => {
    const error = expectManifestError(
      decodeAppManifest(
        JSON.stringify({
          ...VALID_MANIFEST,
          permissions: { required: [], optional: [] },
        }),
        LEGACY_PERMISSIONS_PATH,
      ),
    );
    expect(error?.kind).toBe(SCHEMA_KIND);
  });

  it("returns Left(kind=schema) on wrong field type", () => {
    const error = expectManifestError(
      decodeAppManifest(
        JSON.stringify({ appId: 42, name: TEST_NAME }),
        WRONG_TYPE_PATH,
      ),
    );
    expect(error?.kind).toBe(SCHEMA_KIND);
  });
});

function fullManifest(): AppManifest {
  return {
    ...VALID_MANIFEST,
    description: DESCRIPTION,
    limits: { maxParticipants: MAX_PARTICIPANTS },
    conversations: [
      {
        key: TOWN_SQUARE_KEY,
        name: TOWN_SQUARE_NAME,
        participantFilter: ALL_PARTICIPANTS,
      },
    ],
    hooks: {
      dispatch_authorize: { timeout_ms: DISPATCH_AUTHORIZE_TIMEOUT_MS },
    },
  };
}

function assertMinimalManifestRoundTrip(manifest: AppManifest) {
  const decoded = expectDecodedManifest(
    decodeAppManifest(JSON.stringify(manifest), VALID_MANIFEST_PATH),
  );
  expect(decoded).toEqual(manifest);
}

function expectDecodedManifest(
  result: Either.Either<AppManifest, InvalidAppManifest>,
): AppManifest | undefined {
  return Either.match(result, {
    onLeft: (error) => {
      expect(error).toBeUndefined();
      return undefined;
    },
    onRight: (manifest) => manifest,
  });
}

function expectManifestError(
  result: Either.Either<AppManifest, InvalidAppManifest>,
): InvalidAppManifest | undefined {
  return Either.match(result, {
    onLeft: (error) => error,
    onRight: (manifest) => {
      expect(manifest).toBeUndefined();
      return undefined;
    },
  });
}
