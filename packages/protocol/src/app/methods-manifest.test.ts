import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  AppManifestSchema,
  DispatchAuthorize,
  DispatchRequest,
} from "./methods.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const validateManifest = ajv.compile(AppManifestSchema);
const validateAuthorizeResult = ajv.compile(DispatchAuthorize.resultSchema);
const validateRequestParams = ajv.compile(DispatchRequest.paramsSchema);

describe("AppManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("accepts a full manifest with all optional fields", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      description: "Social deduction game",
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
      extra: "nope",
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects retired permissions field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissions: { required: [], optional: [] },
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects retired permissionTimeoutMs field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissionTimeoutMs: 30000,
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("accepts manifest with dispatch_authorize timeout", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 3000 },
      },
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("accepts hook timeouts above 30s (no upper cap)", () => {
    // Werewolf Phase 2 declares `dispatch_authorize: 900_000ms` (15 min)
    // for the player-input waiter pattern; AppHost enforces the declared
    // timeout via `Effect.timeout(manifestMs)`.
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 900_000 },
      },
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("rejects non-positive hook timeouts", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 0 },
      },
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects additional properties on hook entries", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: {
        dispatch_authorize: { unexpected: "value" },
      },
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects retired hook keys", () => {
    for (const key of [
      "before_dispatch",
      "before_message_delivery",
      "on_close",
      "on_session_active",
      "task_authorize_dispatch",
    ] as const) {
      const manifest = {
        appId: "test",
        name: "Test",
        hooks: { [key]: { timeout_ms: 1000 } },
      };
      expect(validateManifest(manifest)).toBe(false);
    }
  });
});

describe("DispatchAuthorize verdict union", () => {
  it("rejects retry/defer admission results", () => {
    expect(
      validateAuthorizeResult({
        admission: {
          decision: "defer",
          retryAfterMs: 100,
          reason: "slot busy",
        },
      }),
    ).toBe(false);
  });

  it("accepts grant, hold, and deny admission results", () => {
    expect(
      validateAuthorizeResult({
        admission: {
          decision: "grant",
          leaseId: "lease-1",
          leaseTimeoutMs: 90_000,
          dispatchMessageId: "550e8400-e29b-41d4-a716-446655440010",
        },
      }),
    ).toBe(true);
    expect(
      validateAuthorizeResult({
        admission: { decision: "deny", reason: "phase closed" },
      }),
    ).toBe(true);
    expect(
      validateAuthorizeResult({
        admission: { decision: "hold", reason: "waiting for turn" },
      }),
    ).toBe(true);
  });
});

describe("DispatchRequest params", () => {
  it("accepts pending message parts", () => {
    expect(
      validateRequestParams({
        conversationId: "550e8400-e29b-41d4-a716-446655440002",
        messageId: "550e8400-e29b-41d4-a716-446655440003",
        senderAgentId: "550e8400-e29b-41d4-a716-446655440004",
        parts: [{ type: "text", text: "old discussion" }],
        pending: [
          {
            messageId: "550e8400-e29b-41d4-a716-446655440010",
            conversationId: "550e8400-e29b-41d4-a716-446655440002",
            senderAgentId: "550e8400-e29b-41d4-a716-446655440001",
            createdAt: "2026-04-29T22:00:00.000Z",
            receivedAt: "2026-04-29T22:00:00.000Z",
            parts: [{ type: "text", text: "Time to vote" }],
          },
        ],
      }),
    ).toBe(true);
  });
});
