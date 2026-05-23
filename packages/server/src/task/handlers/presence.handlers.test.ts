/**
 * Unit tests for createPresenceHandlers — covers the presence/subscribe
 * NotInContactsError path added in #508.
 */

import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { NotInContactsError } from "@moltzap/protocol";
import {
  connectionId as makeConnectionId,
  userId,
  wireErrorFromInstance,
} from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import type { AgentId } from "../../app/types.js";
import { takeFirstOrFail } from "../../db/effect-kysely-toolkit.js";
import { PresenceService } from "../../network/services/presence.service.js";
import type { PresenceEventSink } from "../../network/services/presence-event-sink.js";
import { ConnectionTag, DbTag, PresenceServiceTag } from "../../app/layers.js";
import type { MoltZapConnection } from "../../transport/connection.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { presenceHandlers } from "./presence.handlers.js";

const ALICE_OWNER = userId("00000000-0000-4000-8000-00000000a11c") as UserId;
const CAROL_OWNER = userId("00000000-0000-4000-8000-00000000ca20") as UserId;
const TEST_CONNECTION_ID = makeConnectionId("test-conn-1");
const TEST_CONNECTION: MoltZapConnection = {
  id: TEST_CONNECTION_ID,
  write: () => Effect.die("test connection: write unused"),
  shutdown: Effect.void,
  auth: null,
  lastPong: Date.now(),
  conversationIds: new Set<string>(),
  mutedConversations: new Set<string>(),
  originator: {
    id: TEST_CONNECTION_ID,
    call: () => Effect.die("test connection: call unused"),
    notify: () => Effect.void,
    failAllPending: () => Effect.void,
    handle: () => Effect.die("test connection: handle unused"),
    resolve: () => Effect.die("test connection: resolve unused"),
  } as MoltZapConnection["originator"],
};
const PRESENCE_SUBSCRIBE = "presence/subscribe";

const noopSink: PresenceEventSink = { publish: () => {} };
const it = effectIt.effect;

let harness: PgliteHarness;

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

function insertAgent(name: string, ownerUserId: UserId | null) {
  return takeFirstOrFail(
    harness.db
      .insertInto("agents")
      .values({
        name,
        api_key_id: `${name}-keyid`,
        api_key_secret_hash: `${name}-hash`,
        claim_token: `${name}-claim`,
        status: "active",
        owner_user_id: ownerUserId,
      })
      .returning("id"),
  );
}

function subscribeBinding() {
  const binding = presenceHandlers.find(
    (handler) => handler.definition.name === PRESENCE_SUBSCRIBE,
  );
  if (binding === undefined)
    expect.fail("presence/subscribe handler not found");
  return binding;
}

function runSubscribe(opts: {
  callerAgentId: AgentId;
  callerOwnerUserId: UserId | null;
  requestedIds: AgentId[];
}) {
  const ctx = {
    auth: {
      agentId: opts.callerAgentId,
      agentStatus: "active",
      ownerUserId: opts.callerOwnerUserId,
    },
    connection: TEST_CONNECTION,
  };
  const testServices = Layer.mergeAll(
    Layer.succeed(DbTag, harness.db),
    Layer.succeed(PresenceServiceTag, new PresenceService(noopSink)),
  );
  type NarrowedSubscribe = Effect.Effect<
    unknown,
    unknown,
    DbTag | PresenceServiceTag
  >;
  const rawHandle = subscribeBinding().handle(
    { agentIds: opts.requestedIds },
    ctx,
  );
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- test boundary: post-Spec-F (#617) `HandlerSlot.handle` widens R-channel to `Context.Tag<unknown, unknown>` for storage; this test re-narrows to the specific tag union it provides via `testServices`. The runtime layer (FullLive in prod, testServices here) resolves the same Tags either way.
  const narrowed = rawHandle as unknown as NarrowedSubscribe; // #ignore-sloppy-code[as-unknown-as]: test boundary re-narrows the post-Spec-F HandlerSlot R-channel widening to the specific tag union the test provides via `testServices`.
  return Effect.exit(
    narrowed.pipe(
      Effect.provideService(ConnectionTag, TEST_CONNECTION),
      Effect.provide(testServices),
    ),
  );
}

function expectNotInContacts(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) expect.fail("expected failed subscribe");

  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) expect.fail("expected typed failure");

  const wire = wireErrorFromInstance(failure.value);
  expect(wire).not.toBeNull();
  expect(wire?.code).toBe(NotInContactsError.code);
  return wire?.data as { agentIds: string[] };
}

function rejectsInvisibleAgent() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice-508", ALICE_OWNER);
    const carol = yield* insertAgent("carol-508", CAROL_OWNER);
    const exit = yield* runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [carol.id as AgentId],
    });

    const data = expectNotInContacts(exit);
    expect(data.agentIds).toContain(carol.id);
  }).pipe(Effect.withSpan("presence.handlers.test.rejectsInvisibleAgent"));
}

function rejectsOnlyInvisibleSubset() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice-mix", ALICE_OWNER);
    const alice2 = yield* insertAgent("alice-sib", ALICE_OWNER);
    const carol = yield* insertAgent("carol-mix", CAROL_OWNER);
    const exit = yield* runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [alice2.id as AgentId, carol.id as AgentId],
    });

    const data = expectNotInContacts(exit);
    expect(data.agentIds).toEqual([carol.id]);
    expect(data.agentIds).not.toContain(alice2.id);
  }).pipe(Effect.withSpan("presence.handlers.test.rejectsOnlyInvisibleSubset"));
}

function succeedsForVisibleIds() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice-ok", ALICE_OWNER);
    const alice2 = yield* insertAgent("alice-sib2", ALICE_OWNER);
    const exit = yield* runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [alice2.id as AgentId],
    });

    expect(Exit.isSuccess(exit)).toBe(true);
  }).pipe(Effect.withSpan("presence.handlers.test.succeedsForVisibleIds"));
}

describe("presence/subscribe — NotInContactsError (#508)", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "rejects an agentId outside the caller visibility set",
    rejectsInvisibleAgent,
  );
  it("rejects only the non-visible subset", rejectsOnlyInvisibleSubset);
  it("succeeds when all requested IDs are visible", succeedsForVisibleIds);
});
