import { describe, it, expect } from "vitest";
import { Either } from "effect";
import { decodeAppManifest, InvalidAppManifest } from "./standalone.js";

// Boundary-validation tests for the on-disk app-manifest decoder.
// Issue #468: `JSON.parse(json)` previously flowed an untyped `any`
// straight into `app.registerApp(manifest)`. `decodeAppManifest`
// validates against `AppManifestSchema` before the value reaches the
// service surface; these tests exercise both branches.

const VALID_MANIFEST = {
  appId: "werewolf",
  name: "Werewolf",
};

describe("decodeAppManifest", () => {
  it("returns Right(manifest) for a valid manifest JSON", () => {
    const result = decodeAppManifest(
      JSON.stringify(VALID_MANIFEST),
      "/path/to/werewolf.json",
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.appId).toBe("werewolf");
      expect(result.right.name).toBe("Werewolf");
    }
  });

  it("accepts a full manifest with optional fields", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      description: "Social deduction",
      limits: { maxParticipants: 12 },
      conversations: [
        { key: "town_square", name: "Town Square", participantFilter: "all" },
      ],
      hooks: {
        task_authorize_dispatch: { timeout_ms: 5000 },
      },
    };
    const result = decodeAppManifest(
      JSON.stringify(manifest),
      "/path/to/werewolf.json",
    );
    expect(Either.isRight(result)).toBe(true);
  });

  it("returns Left(InvalidAppManifest, kind=parse) for malformed JSON", () => {
    const result = decodeAppManifest(
      "{ not valid json",
      "/path/to/broken.json",
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidAppManifest);
      expect(result.left.kind).toBe("parse");
      expect(result.left.path).toBe("/path/to/broken.json");
      expect(result.left.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns Left(InvalidAppManifest, kind=schema) when required fields missing", () => {
    const result = decodeAppManifest(
      JSON.stringify({ appId: "test" }), // missing `name`
      "/path/to/missing-name.json",
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidAppManifest);
      expect(result.left.kind).toBe("schema");
      expect(result.left.path).toBe("/path/to/missing-name.json");
      expect(result.left.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns Left(kind=schema) on additional properties", () => {
    const result = decodeAppManifest(
      JSON.stringify({ ...VALID_MANIFEST, unexpected: "nope" }),
      "/path/to/extra-field.json",
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("schema");
    }
  });

  it("returns Left(kind=schema) on retired permissions field", () => {
    // Phase 1B deleted the entire permissions surface; a manifest still
    // carrying a permissions block must reject — proves the deletion is
    // enforced end-to-end, not just at the wire boundary.
    const result = decodeAppManifest(
      JSON.stringify({
        ...VALID_MANIFEST,
        permissions: { required: [], optional: [] },
      }),
      "/path/to/legacy-permissions.json",
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("schema");
    }
  });

  it("returns Left(kind=schema) on wrong field type", () => {
    const result = decodeAppManifest(
      JSON.stringify({ appId: 42, name: "Test" }), // appId must be string
      "/path/to/wrong-type.json",
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("schema");
    }
  });
});
