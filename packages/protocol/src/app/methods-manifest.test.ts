import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  validateAppManifest,
  DispatchAuthorize,
  DispatchRequest,
} from "./methods.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const validateAuthorizeResult = ajv.compile(DispatchAuthorize.resultSchema);
const validateRequestParams = ajv.compile(DispatchRequest.paramsSchema);

const expectValidManifest = (manifest: unknown): void => {
  expect(validateAppManifest(manifest)._tag).toBe("Valid");
};

const expectInvalidManifest = (manifest: unknown): void => {
  expect(validateAppManifest(manifest)._tag).toBe("Invalid");
};

describe("AppManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
    };
    expectValidManifest(manifest);
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
    expectValidManifest(manifest);
  });

  it("rejects manifest missing required fields", () => {
    expectInvalidManifest({ appId: "test" });
    expectInvalidManifest({ name: "test" });
    expectInvalidManifest({});
  });

  it("rejects invalid participantFilter values", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      conversations: [
        { key: "main", name: "Main", participantFilter: "invalid" },
      ],
    };
    expectInvalidManifest(manifest);
  });

  it("rejects additional properties", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      extra: "nope",
    };
    expectInvalidManifest(manifest);
  });

  it("rejects retired permissions field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissions: { required: [], optional: [] },
    };
    expectInvalidManifest(manifest);
  });

  it("rejects retired permissionTimeoutMs field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissionTimeoutMs: 30000,
    };
    expectInvalidManifest(manifest);
  });

  it("accepts manifest with dispatch_authorize timeout", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 3000 },
      },
    };
    expectValidManifest(manifest);
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
    expectValidManifest(manifest);
  });

  it("rejects non-positive hook timeouts", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 0 },
      },
    };
    expectInvalidManifest(manifest);
  });

  it("rejects additional properties on hook entries", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: {
        dispatch_authorize: { unexpected: "value" },
      },
    };
    expectInvalidManifest(manifest);
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
      expectInvalidManifest(manifest);
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
