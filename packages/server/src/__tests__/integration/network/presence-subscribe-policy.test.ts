/**
 * Integration tests for presence/subscribe contact-policy error (#508).
 *
 * Verifies that the server propagates NotInContactsError over the JSON-RPC
 * wire when a caller requests agentIds outside their contact-visible set.
 * Test 26 covers broadcast lifecycle with a shared owner; this file covers
 * the policy-rejection path with distinct owners and no contact relationship.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Cause, Effect, Exit, Option } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  createTestUser,
  registerClaimedAgent,
} from "../helpers.js";
import { agentId, userId, WIRE_ERROR_TAG } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import { PresenceSubscribe } from "@moltzap/protocol/network";

const it = effectIt.live;

// Two distinct owners with no contact relationship.
const REGISTRATION_SECRET = "presence-policy-test-secret-gh508";
const ALICE_USER_ID = userId("00000000-0000-4000-8000-00000000a5a5") as UserId;
const CAROL_USER_ID = userId("00000000-0000-4000-8000-00000000c5c5") as UserId;
const ALICE_USER = createTestUser("alice", ALICE_USER_ID);
const CAROL_USER = createTestUser("carol", CAROL_USER_ID);

let baseUrl: string;
let wsUrl: string;
let agentCounter = 0;

beforeAll(() =>
  Effect.runPromise(
    startTestServerEffect({
      registrationSecret: REGISTRATION_SECRET,
    }).pipe(
      Effect.tap((server) =>
        Effect.sync(() => {
          baseUrl = server.baseUrl;
          wsUrl = server.wsUrl;
        }),
      ),
    ),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() =>
  Effect.runPromise(
    resetTestDbEffect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          agentCounter = 0;
        }),
      ),
    ),
  ),
);

function registerClaimed(name: string, ownerUserId: UserId) {
  return registerClaimedAgent({
    baseUrl,
    inviteCode: REGISTRATION_SECRET,
    name,
    user: ownerUserId === ALICE_USER_ID ? ALICE_USER : CAROL_USER,
  });
}

function registerAndConnectOwned(opts: { name: string; ownerUserId: UserId }) {
  return Effect.gen(function* () {
    const idx = ++agentCounter;
    const reg = yield* registerClaimed(`${opts.name}-${idx}`, opts.ownerUserId);
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return { agentId: reg.agentId, client };
  });
}

/** Extract the typed tagged RPC failure from an exit's failure cause. */
function extractTaggedRpcError(exit: Exit.Exit<unknown, unknown>): {
  readonly _tag: string;
  readonly data?: unknown;
} {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) expect.fail("expected failed RPC");
  const failureOpt = Cause.failureOption(exit.cause);
  expect(Option.isSome(failureOpt)).toBe(true);
  if (Option.isNone(failureOpt)) expect.fail("expected RPC error");
  const err = failureOpt.value;
  expect((err as { _tag?: unknown })._tag).toBeTypeOf("string");
  return err as { readonly _tag: string; readonly data?: unknown };
}

function rejectsInvisibleAgent() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnectOwned({
      name: "alice-pol",
      ownerUserId: ALICE_USER_ID,
    });
    const carol = yield* registerAndConnectOwned({
      name: "carol-pol",
      ownerUserId: CAROL_USER_ID,
    });
    const exit = yield* Effect.exit(
      alice.client.sendRpc(PresenceSubscribe, {
        agentIds: [agentId(carol.agentId)],
      }),
    );

    const err = extractTaggedRpcError(exit);
    expect(err._tag).toBe(WIRE_ERROR_TAG.NotInContacts);
    const data = err.data as { agentIds: string[] } | undefined;
    expect(data?.agentIds).toContain(carol.agentId);
  });
}

function rejectsOnlyInvisibleSubset() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnectOwned({
      name: "alice-mix",
      ownerUserId: ALICE_USER_ID,
    });
    const alice2 = yield* registerAndConnectOwned({
      name: "alice-mix2",
      ownerUserId: ALICE_USER_ID,
    });
    const carol = yield* registerAndConnectOwned({
      name: "carol-mix",
      ownerUserId: CAROL_USER_ID,
    });
    const exit = yield* Effect.exit(
      alice.client.sendRpc(PresenceSubscribe, {
        agentIds: [agentId(alice2.agentId), agentId(carol.agentId)],
      }),
    );

    const err = extractTaggedRpcError(exit);
    expect(err._tag).toBe(WIRE_ERROR_TAG.NotInContacts);
    const data = err.data as { agentIds: string[] } | undefined;
    expect(data?.agentIds).toContain(carol.agentId);
    expect(data?.agentIds).not.toContain(alice2.agentId);
  });
}

describe("presence/subscribe — NotInContactsError wire propagation (#508)", () => {
  it(
    "returns NotInContactsError when subscribing to an agentId outside the caller's contact-visible set",
    rejectsInvisibleAgent,
  );

  it(
    "returns NotInContactsError listing only the rejected subset when some IDs are visible",
    rejectsOnlyInvisibleSubset,
  );
});
