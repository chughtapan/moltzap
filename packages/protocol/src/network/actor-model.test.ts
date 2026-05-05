/**
 * Runtime tests for the actor-model brand factories + a runtime negative
 * canary asserting the actor-model names never appear as runtime values on
 * the protocol flat barrel.
 *
 * Type-level leaks (`export type { ... }` re-exports) are caught separately
 * by `actor-model.types-check.ts`, which is typechecked by `pnpm typecheck`
 * (this `*.test.ts` file is excluded from `tsc --build` per
 * `packages/protocol/tsconfig.json`).
 */
import { describe, expect, it } from "vitest";
import * as flatBarrel from "../index.js";
import {
  userId as schemaPrimitivesUserId,
  agentId as schemaPrimitivesAgentId,
} from "../schema/primitives.js";
import {
  agentId,
  endpointAddress,
  userId,
  type AgentId,
  type AuthenticatedIdentity,
  type EndpointAddress,
  type EndpointKind,
  type EndpointRegistration,
  type UserId,
} from "./actor-model.js";

describe("actor-model brand factories", () => {
  it("brands a string as UserId", () => {
    const u: UserId = userId("00000000-0000-4000-8000-000000000001");
    expect(u).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("brands a string as AgentId", () => {
    const a: AgentId = agentId("00000000-0000-4000-8000-000000000002");
    expect(a).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("brands a string as EndpointAddress", () => {
    const e: EndpointAddress = endpointAddress(
      "tm:agent:00000000-0000-4000-8000-000000000001",
    );
    expect(e).toBe("tm:agent:00000000-0000-4000-8000-000000000001");
  });

  it("rejects non-canonical endpoint formats at construction", () => {
    expect(() => endpointAddress("ws://localhost:1")).toThrow();
    expect(() => endpointAddress("")).toThrow();
    expect(() => endpointAddress("tm:agent:not-a-uuid")).toThrow();
    expect(() => endpointAddress("tm:unknown:uuid-here")).toThrow();
  });
});

describe("actor-model record + union shapes", () => {
  it("constructs an EndpointRegistration agent arm", () => {
    const reg: EndpointRegistration = {
      kind: "agent",
      address: endpointAddress("tm:agent:00000000-0000-4000-8000-000000000001"),
      agentId: agentId("00000000-0000-4000-8000-000000000001"),
    };
    expect(reg.kind).toBe("agent");
  });

  it("constructs an EndpointRegistration taskManager arm", () => {
    const reg: EndpointRegistration = {
      kind: "taskManager",
      address: endpointAddress("tm:app:00000000-0000-4000-8000-000000000099"),
    };
    expect(reg.kind).toBe("taskManager");
  });

  it("constructs an AuthenticatedIdentity", () => {
    const identity: AuthenticatedIdentity = {
      agentId: agentId("00000000-0000-4000-8000-000000000001"),
      userId: userId("00000000-0000-4000-8000-000000000002"),
    };
    expect(identity.agentId).toBe("00000000-0000-4000-8000-000000000001");
    expect(identity.userId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("EndpointKind switch is exhaustive (compile-time + runtime)", () => {
    // Adding a third `EndpointKind` makes this switch fail to compile; the
    // `absurd` default branch is the Principle 4 anchor that enforces it.
    const describeKind = (k: EndpointKind): string => {
      switch (k) {
        case "agent":
          return "agent";
        case "taskManager":
          return "task manager";
        default: {
          const _absurd: never = k;
          return _absurd;
        }
      }
    };
    expect(describeKind("agent")).toBe("agent");
    expect(describeKind("taskManager")).toBe("task manager");
  });
});

/**
 * Runtime negative canary — guards against accidental *value-level* leaks
 * onto the protocol flat barrel.
 *
 * Most of the actor-model names (`UserId`, `AgentId`, `EndpointKind`, ...)
 * are TypeScript types and erase at emit, so they cannot appear in
 * `Object.keys(flatBarrel)` regardless. The type-leak guard lives in
 * `actor-model.types-check.ts`; this test catches the residual case where
 * someone re-exports a *value* (e.g., a TypeBox schema constant) under one
 * of the reserved PascalCase names. Pre-Phase-4 the slot must stay empty.
 */
describe("flat-barrel runtime negative canary", () => {
  // Names introduced by `actor-model.ts`. Each must stay scoped to the
  // module's own import path; none should appear as a runtime value of the
  // flat barrel `@moltzap/protocol`.
  const FORBIDDEN_RUNTIME_NAMES: ReadonlyArray<string> = [
    "UserId",
    "AgentId",
    "EndpointAddress",
    "EndpointKind",
    "EndpointRegistration",
    "AuthenticatedIdentity",
  ];

  // Hoisted: `Object.keys` is invariant across all forbidden-name cases.
  const flatBarrelKeys = Object.keys(flatBarrel);

  for (const name of FORBIDDEN_RUNTIME_NAMES) {
    it(`@moltzap/protocol does not re-export "${name}" as a runtime value`, () => {
      expect(flatBarrelKeys).not.toContain(name);
    });
  }
});

/**
 * Lowercase factory shadowing canary — Phase 2 left the lowercase `userId`/
 * `agentId` factories from `schema/primitives.ts` reachable on the flat
 * barrel (they decode UUID strings into the wire-layer brand). The new
 * actor-model module also exports `userId`/`agentId` (no-op nominal brands).
 * Both coexist on different import paths today.
 *
 * If a future Phase-4 PR carelessly re-exports `./network/actor-model.js`
 * via the flat barrel, the actor-model factory would silently shadow the
 * schema/primitives one for any consumer that imports from
 * `@moltzap/protocol` — and the boundary UUID validation would silently
 * drop. These assertions pin the existing identity so the shadowing PR
 * fails this test instead of CI passing with broken validation.
 */
describe("flat-barrel factory-shadowing canary", () => {
  it("flat-barrel `userId` is the schema/primitives factory (not actor-model's)", () => {
    expect(flatBarrel.userId).toBe(schemaPrimitivesUserId);
    expect(flatBarrel.userId).not.toBe(userId);
  });

  it("flat-barrel `agentId` is the schema/primitives factory (not actor-model's)", () => {
    expect(flatBarrel.agentId).toBe(schemaPrimitivesAgentId);
    expect(flatBarrel.agentId).not.toBe(agentId);
  });

  it("flat-barrel does not re-export the actor-model `endpointAddress` factory", () => {
    // No schema/primitives counterpart exists for `endpointAddress`, so the
    // slot on the flat barrel must stay empty pre-Phase-4.
    expect(flatBarrel).not.toHaveProperty("endpointAddress");
  });
});
