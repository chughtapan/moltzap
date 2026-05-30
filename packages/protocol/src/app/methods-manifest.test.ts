import { describe, it, expect } from "vitest";
import { Either, type Schema } from "effect";
import * as fc from "fast-check";
import {
  validateAppManifest,
  DispatchAuthorize,
  DispatchRequest,
} from "./methods.js";
import { decodesStrictly } from "../schema-primitives.js";

// Strict, excess-rejecting decode check — the parity oracle for the former
// `ajv.compile(schema)` strict validators (post-#723 Effect Schema cutover).
const decodes = <A, I>(schema: Schema.Schema<A, I>, value: unknown): boolean =>
  decodesStrictly(schema, value);

const validateAuthorizeResult = (value: unknown): boolean =>
  decodes(DispatchAuthorize.resultSchema, value);
const validateRequestParams = (value: unknown): boolean =>
  decodes(DispatchRequest.paramsSchema, value);
const MANIFEST_PROPERTY_RUNS = 25;

const manifestIsValid = (manifest: unknown): boolean =>
  Either.match(validateAppManifest(manifest), {
    onLeft: () => false,
    onRight: () => true,
  });

const manifestIsInvalid = (manifest: unknown): boolean =>
  Either.match(validateAppManifest(manifest), {
    onLeft: () => true,
    onRight: () => false,
  });

const minimalManifestArbitrary = fc.record({
  appId: fc.string(),
  name: fc.string(),
});

describe("AppManifestSchema required shape", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
    };
    expect(manifestIsValid(manifest)).toBe(true);
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
    expect(manifestIsValid(manifest)).toBe(true);
  });

  it("accepts generated minimal manifests", () => {
    const property = fc.property(minimalManifestArbitrary, manifestIsValid);
    fc.assert(property, { numRuns: MANIFEST_PROPERTY_RUNS });
    expect(manifestIsValid({ appId: "", name: "" })).toBe(true);
  });

  it("rejects manifest missing required fields", () => {
    expect(manifestIsInvalid({ appId: "test" })).toBe(true);
    expect(manifestIsInvalid({ name: "test" })).toBe(true);
    expect(manifestIsInvalid({})).toBe(true);
  });
});

describe("AppManifestSchema closed shape", () => {
  it("rejects invalid participantFilter values", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      conversations: [
        { key: "main", name: "Main", participantFilter: "invalid" },
      ],
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });

  it("rejects additional properties", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      extra: "nope",
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });
});

describe("AppManifestSchema retired fields", () => {
  it("rejects retired permissions field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissions: { required: [], optional: [] },
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });

  it("rejects retired permissionTimeoutMs field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      permissionTimeoutMs: 30000,
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });
});

describe("AppManifestSchema hooks", () => {
  it("accepts manifest with dispatch_authorize timeout", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 3000 },
      },
    };
    expect(manifestIsValid(manifest)).toBe(true);
  });

  it("accepts manifest with task_create timeout", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        task_create: { timeout_ms: 3000 },
      },
    };
    expect(manifestIsValid(manifest)).toBe(true);
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
    expect(manifestIsValid(manifest)).toBe(true);
  });
});

describe("AppManifestSchema invalid hooks", () => {
  it("rejects non-positive hook timeouts", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: {
        dispatch_authorize: { timeout_ms: 0 },
      },
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });

  it("rejects additional properties on hook entries", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: {
        dispatch_authorize: { unexpected: "value" },
      },
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });
});

describe("AppManifestSchema retired hooks", () => {
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
      expect(manifestIsInvalid(manifest)).toBe(true);
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
          leaseId: "550e8400-e29b-41d4-a716-446655440011",
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
