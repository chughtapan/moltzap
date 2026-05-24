import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  ConversationFullError,
  NotFoundError,
  NotInContactsError,
} from "@moltzap/protocol";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../../layers.js";
import type { ConversationService } from "../../../task/services/conversation.service.js";
import { obtainConversationCreateAuthorization } from "../conversation-create-authorization.js";

const it = effectIt.effect;

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

function createAuthReturnsOwnerMap() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const value = yield* obtainConversationCreateAuthorization({
      agentIds: [BOB],
      creatorAgentId: ALICE,
    }).pipe(Effect.provide(layer));
    expect(value).toEqual({ ownerByAgentId: ownerMap });
  });
}

function createAuthMissingAgent() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      loadAgentOwners: () =>
        Effect.fail(new NotFoundError({ message: "agent missing" })),
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
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
      assertContactPolicyForCreate: () =>
        Effect.fail(new NotInContactsError({ message: "blocked" })),
      assertGroupCapacityForCreate: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
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
      assertContactPolicyForCreate: () => Effect.void,
      assertGroupCapacityForCreate: () =>
        Effect.fail(new ConversationFullError({ message: "too many" })),
    });
    const exit = yield* Effect.exit(
      obtainConversationCreateAuthorization({
        agentIds: [BOB],
        creatorAgentId: ALICE,
      }).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ConversationFullError);
  });
}

describe("obtainConversationCreateAuthorization", () => {
  it("returns ownerByAgentId once gates pass", createAuthReturnsOwnerMap);
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
