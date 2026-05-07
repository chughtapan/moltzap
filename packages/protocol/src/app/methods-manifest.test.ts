import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { AppManifestSchema, AppsAuthorizeDispatch } from "./methods.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const validateManifest = ajv.compile(AppManifestSchema);
const validateAuthorizeDispatchResult = ajv.compile(
  AppsAuthorizeDispatch.resultSchema,
);
const validateAuthorizeDispatchParams = ajv.compile(
  AppsAuthorizeDispatch.paramsSchema,
);

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

  // The `permissions` field was deleted in Phase 1B alongside the entire
  // permissions surface (RPCs, server class, DB table). The schema is
  // `additionalProperties: false`, so a manifest carrying a stale
  // permissions block must reject — proves the field is gone, not silently
  // accepted via a missed schema edit.
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

  it("accepts manifest with task_authorize_dispatch timeout", () => {
    // Phase 9b consumer-migration (sub-issue #460): the legacy
    // `before_message_delivery` / `on_close` / `on_session_active` hook
    // keys retired with their wire RPCs; only `task_authorize_dispatch`
    // (renamed from `before_dispatch`) remains.
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        task_authorize_dispatch: { timeout_ms: 3000 },
      },
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("accepts hook timeouts above 30s (no upper cap)", () => {
    // Werewolf Phase 2 declares `task_authorize_dispatch: 900_000ms`
    // (15 min) for the player-input waiter pattern. The schema-level
    // 30s `maximum` was removed in B.4 follow-up (#324) per architect
    // plan §8.1; AppHost enforces the declared timeout via
    // `Effect.timeout(manifestMs)`.
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        task_authorize_dispatch: { timeout_ms: 900_000 },
      },
    };
    expect(validateManifest(manifest)).toBe(true);
  });

  it("rejects non-positive hook timeouts", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        task_authorize_dispatch: { timeout_ms: 0 },
      },
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects additional properties on hook entries", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: {
        task_authorize_dispatch: { unexpected: "value" },
      },
    };
    expect(validateManifest(manifest)).toBe(false);
  });

  it("rejects retired hook keys (`before_dispatch`, `before_message_delivery`, `on_close`, `on_session_active`)", () => {
    // Phase 9b consumer-migration regression guard: these four keys
    // were the legacy appCallback group; retired by sub-issue #460.
    // The schema's `additionalProperties: false` enforces the deletion.
    for (const key of [
      "before_dispatch",
      "before_message_delivery",
      "on_close",
      "on_session_active",
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

describe("AppsAuthorizeDispatch", () => {
  it("rejects retry/defer admission results", () => {
    expect(
      validateAuthorizeDispatchResult({
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
      validateAuthorizeDispatchResult({
        admission: {
          decision: "grant",
          leaseId: "lease-1",
          leaseTimeoutMs: 90_000,
          dispatchMessageId: "550e8400-e29b-41d4-a716-446655440010",
        },
      }),
    ).toBe(true);
    expect(
      validateAuthorizeDispatchResult({
        admission: { decision: "deny", reason: "phase closed" },
      }),
    ).toBe(true);
    expect(
      validateAuthorizeDispatchResult({
        admission: { decision: "hold", reason: "waiting for turn" },
      }),
    ).toBe(true);
  });

  it("accepts pending message parts in authorization params", () => {
    expect(
      validateAuthorizeDispatchParams({
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
