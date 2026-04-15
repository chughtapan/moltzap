import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  AppManifestSchema,
  AppSessionSchema,
  AppParticipantStatusEnum,
} from "./apps.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const validateManifest = ajv.compile(AppManifestSchema);
const validateSession = ajv.compile(AppSessionSchema);
const validateStatus = ajv.compile(AppParticipantStatusEnum);

describe("AppManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      permissions: { required: [], optional: [] },
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("accepts a full manifest with all optional fields", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      description: "Social deduction game",
      permissions: {
        required: [{ resource: "calendar", access: ["read", "write"] }],
        optional: [{ resource: "email", access: ["read"] }],
      },
      skillUrl: "https://example.com/skill.md",
      skillMinVersion: "0.2",
      challengeTimeoutMs: 60000,
      permissionTimeoutMs: 300000,
      limits: { maxParticipants: 12 },
      conversations: [
        { key: "town_square", name: "Town Square", participantFilter: "all" },
        { key: "den", name: "Werewolf Den", participantFilter: "none" },
      ],
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("rejects manifest missing required fields", () => {
    expect(validateManifest({ appId: "test" })).toBe(false);
    expect(validateManifest({ name: "test" })).toBe(false);
    expect(validateManifest({})).toBe(false);
  });

  it("rejects invalid participantFilter values", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissions: { required: [], optional: [] },
      conversations: [
        { key: "main", name: "Main", participantFilter: "invalid" },
      ],
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects additional properties", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissions: { required: [], optional: [] },
      extra: "nope",
    };
    expect(validateManifest(manifest)).toBe(false);
  });
});

describe("AppSessionSchema", () => {
  it("accepts a valid session", () => {
    const session = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      appId: "werewolf",
      initiatorAgentId: "550e8400-e29b-41d4-a716-446655440001",
      status: "waiting",
      conversations: {
        town_square: "550e8400-e29b-41d4-a716-446655440002",
      },
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    expect(validateSession(session)).toBe(true);
  });

  it("rejects invalid status", () => {
    const session = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      appId: "werewolf",
      initiatorAgentId: "550e8400-e29b-41d4-a716-446655440001",
      status: "invalid",
      conversations: {},
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    expect(validateSession(session)).toBe(false);
  });
});

describe("AppParticipantStatusEnum", () => {
  it("accepts valid values", () => {
    expect(validateStatus("pending")).toBe(true);
    expect(validateStatus("admitted")).toBe(true);
    expect(validateStatus("rejected")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(validateStatus("invalid")).toBe(false);
    expect(validateStatus("")).toBe(false);
  });
});
