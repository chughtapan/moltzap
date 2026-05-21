/**
 * Unit tests for the Spec E (#601) Phase 3 r3 composite obtain
 * helpers — `obtainConversationCreateAuthorization` (Architect
 * Decision C) and `obtainAddParticipantPermission` (Architect
 * Decision D).
 *
 * Split from `obtain-helpers.test.ts` to keep the latter under the
 * `max-lines: 1050` lint cap; mirrors the same stubbing pattern
 * (per-method `Layer.succeed(ServiceTag, impl as Service)`).
 */

import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  ConversationFullError,
  NotFoundError,
  NotInContactsError,
  type Conversation,
} from "@moltzap/protocol";
import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
} from "@moltzap/protocol/testing";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../../layers.js";
import type { ConversationService } from "../../../task/services/conversation.service.js";
import { obtainConversationCreateAuthorization } from "../conversation-create-authorization.js";

const it = effectIt.effect;

const CONV_ID = makeConversationId("00000000-0000-4000-8000-00000000c001");
const ALICE = makeAgentId("00000000-0000-4000-8000-00000000aa11");
const BOB = makeAgentId("00000000-0000-4000-8000-00000000bb22");

function conversationServiceLayer(impl: Partial<ConversationService>) {
  return Layer.succeed(ConversationServiceTag, impl as ConversationService);
}

function expectFailureOf<E>(
  exit: Exit.Exit<unknown, E>,
  ctor: new (...args: never[]) => E,
): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const opt = Cause.failureOption(exit.cause);
  expect(Option.isSome(opt)).toBe(true);
  if (Option.isNone(opt)) return;
  expect(opt.value).toBeInstanceOf(ctor);
}

// ── obtainConversationCreateAuthorization (Decision C, r3) ────────────

function makeConversationFixture(): Conversation {
  return {
    id: CONV_ID,
    type: "dm",
    createdBy: ALICE,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function createAuthExistingDmShortCircuit() {
  return Effect.gen(function* () {
    const existingDm = makeConversationFixture();
    let policyCalls = 0;
    let capacityCalls = 0;
    const layer = conversationServiceLayer({
      loadAgentOwners: () =>
        Effect.succeed(new Map<AgentId, string | null>([[BOB, "owner-bob"]])),
      existingDmForCreate: () => Effect.succeed(existingDm),
      assertContactPolicyForCreate: () => {
        policyCalls += 1;
        return Effect.void;
      },
      assertGroupCapacityForCreate: () => {
        capacityCalls += 1;
        return Effect.void;
      },
    });
    const value = yield* obtainConversationCreateAuthorization({
      type: "dm",
      agentIds: [BOB],
      creatorAgentId: ALICE,
    }).pipe(Effect.provide(layer));
    expect(value).toEqual({ _tag: "ExistingDm", conversation: existingDm });
    // Short-circuit must skip the policy + capacity gates.
    expect(policyCalls).toBe(0);
    expect(capacityCalls).toBe(0);
  });
}

function createAuthPermittedToCreate() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      existingDmForCreate: () => Effect.succeed(null),
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const value = yield* obtainConversationCreateAuthorization({
      type: "group",
      agentIds: [BOB],
      creatorAgentId: ALICE,
    }).pipe(Effect.provide(layer));
    expect(value).toEqual({
      _tag: "PermittedToCreate",
      ownerByAgentId: ownerMap,
    });
  });
}

function createAuthMissingAgent() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      loadAgentOwners: () =>
        Effect.fail(new NotFoundError({ message: "agent missing" })),
      existingDmForCreate: () => Effect.succeed(null),
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
        type: "group",
        agentIds: [BOB],
        creatorAgentId: ALICE,
      }).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

function createAuthContactPolicyDenied() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      existingDmForCreate: () => Effect.succeed(null),
      assertContactPolicyForCreate: () =>
        Effect.fail(new NotInContactsError({ message: "blocked" })),
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
        type: "group",
        agentIds: [BOB],
        creatorAgentId: ALICE,
      }).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotInContactsError);
  });
}

function createAuthCapacityRejected() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      existingDmForCreate: () => Effect.succeed(null),
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () =>
        Effect.fail(new ConversationFullError({ message: "too many" })),
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
        type: "group",
        agentIds: [BOB],
        creatorAgentId: ALICE,
      }).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ConversationFullError);
  });
}

describe("obtainConversationCreateAuthorization", () => {
  it(
    "ExistingDm short-circuit skips policy + capacity gates",
    createAuthExistingDmShortCircuit,
  );
  it(
    "PermittedToCreate carries ownerByAgentId when dedup misses",
    createAuthPermittedToCreate,
  );
  it("propagates NotFoundError from loadAgentOwners", createAuthMissingAgent);
  it(
    "propagates NotInContactsError from contact-policy gate",
    createAuthContactPolicyDenied,
  );
  it(
    "propagates ConversationFullError from capacity gate",
    createAuthCapacityRejected,
  );
});

// Spec D3 cutover: the `ConversationsAddParticipant` RPC and its
// composite `obtainAddParticipantPermission` helper retire with the
// legacy `Conversations*` surface. `TaskConversationAddParticipant` is
// gated by `TmAuthority` + `obtainContactPolicyForAdd` instead.
