import { describe, it, expect } from "vitest";
import { Either } from "effect";
import * as fc from "fast-check";
import { validateAppManifest } from "./manifest.js";

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

const OPEN_HOOKS = {
  dispatch_authorize: { kind: "grant" },
  message_authorize: { kind: "forwardAllExceptSender" },
} as const;

const minimalManifestArbitrary = fc.record({
  appId: fc.string(),
  name: fc.string(),
  hooks: fc.constant(OPEN_HOOKS),
});

describe("AppManifestSchema required shape", () => {
  it("accepts a manifest with both policies declared", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      hooks: OPEN_HOOKS,
    };
    expect(manifestIsValid(manifest)).toBe(true);
  });

  it("accepts a full manifest with all optional fields", () => {
    const manifest = {
      appId: "werewolf",
      name: "Werewolf",
      description: "Social deduction game",
      limits: { maxParticipants: 12 },
      hooks: OPEN_HOOKS,
    };
    expect(manifestIsValid(manifest)).toBe(true);
  });

  it("accepts generated manifests with both policies declared", () => {
    const property = fc.property(minimalManifestArbitrary, manifestIsValid);
    fc.assert(property, { numRuns: MANIFEST_PROPERTY_RUNS });
    expect(manifestIsValid({ appId: "", name: "", hooks: OPEN_HOOKS })).toBe(
      true,
    );
  });

  it("rejects manifest missing a required field or policy", () => {
    // appId / name / hooks are all required, as is each policy within hooks.
    expect(manifestIsInvalid({ appId: "test", hooks: OPEN_HOOKS })).toBe(true);
    expect(manifestIsInvalid({ name: "test", hooks: OPEN_HOOKS })).toBe(true);
    expect(manifestIsInvalid({})).toBe(true);
    expect(manifestIsInvalid({ appId: "test", name: "Test" })).toBe(true);
    expect(manifestIsInvalid({ appId: "test", name: "Test", hooks: {} })).toBe(
      true,
    );
    expect(
      manifestIsInvalid({
        appId: "test",
        name: "Test",
        hooks: { dispatch_authorize: { kind: "grant" } },
      }),
    ).toBe(true);
  });
});

describe("AppManifestSchema closed shape", () => {
  it("rejects additional properties", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: OPEN_HOOKS,
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
      hooks: OPEN_HOOKS,
      permissions: { required: [], optional: [] },
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });

  it("rejects retired permissionTimeoutMs field", () => {
    const manifest = {
      appId: "test",
      name: "Test",
      hooks: OPEN_HOOKS,
      permissionTimeoutMs: 30000,
    };
    expect(manifestIsInvalid(manifest)).toBe(true);
  });
});

const withDispatch = (policy: unknown) => ({
  ...OPEN_HOOKS,
  dispatch_authorize: policy,
});

const manifestWithHooks = (hooks: unknown) => ({
  appId: "w",
  name: "W",
  hooks,
});

// Every dispatch policy shape the schema must reject. The decode
// contract is "a `dispatch_authorize` slot is exactly one of the three
// declared arms, fully populated"; each entry is a way to violate it.
const REJECTED_DISPATCH_POLICIES: ReadonlyArray<readonly [string, unknown]> = [
  ["non-positive hook timeout", { kind: "hook", timeoutMs: 0 }],
  ["static deny without a reason", { kind: "deny" }],
  ["hook policy without a timeout", { kind: "hook" }],
  ["unknown policy kind", { kind: "defer" }],
  ["excess property on a policy arm", { kind: "grant", unexpected: "value" }],
];

// @agent-code-guard/regression-only: pins each declared policy arm of the
// decode contract; the structural property over generated manifests lives
// in the "required shape" scope above.
describe("AppManifestSchema hook policies", () => {
  it("accepts the static open policies", () => {
    expect(manifestIsValid({ appId: "w", name: "W", hooks: OPEN_HOOKS })).toBe(
      true,
    );
  });

  it("accepts the static deny policies with a reason", () => {
    const hooks = {
      dispatch_authorize: { kind: "deny", reason: "closed" },
      message_authorize: { kind: "deny", reason: "muted" },
    };
    expect(manifestIsValid(manifestWithHooks(hooks))).toBe(true);
  });

  it("accepts a hook policy with a timeout", () => {
    const hooks = {
      dispatch_authorize: { kind: "hook", timeoutMs: 3000 },
      message_authorize: { kind: "hook", timeoutMs: 3000 },
    };
    expect(manifestIsValid(manifestWithHooks(hooks))).toBe(true);
  });

  it("accepts hook timeouts above 30s (no upper cap)", () => {
    // A 900_000ms (15 min) moderator timeout for a player-input waiter
    // pattern is legal; hook execution enforces it via `Effect.timeout(timeoutMs)`.
    const hooks = withDispatch({ kind: "hook", timeoutMs: 900_000 });
    expect(manifestIsValid(manifestWithHooks(hooks))).toBe(true);
  });

  it("rejects every malformed dispatch policy shape", () => {
    for (const [label, policy] of REJECTED_DISPATCH_POLICIES) {
      expect(
        manifestIsInvalid(manifestWithHooks(withDispatch(policy))),
        label,
      ).toBe(true);
    }
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
        hooks: { ...OPEN_HOOKS, [key]: { kind: "hook", timeoutMs: 1000 } },
      };
      expect(manifestIsInvalid(manifest)).toBe(true);
    }
  });
});
