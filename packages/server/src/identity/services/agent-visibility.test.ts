import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Effect } from "effect";
import { userId } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import type { AgentId } from "../../app/types.js";
import { takeFirstOrFail } from "../../db/effect-kysely-toolkit.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { visibleAgentIds } from "./agent-visibility.js";

const ALICE_OWNER = userId("00000000-0000-4000-8000-00000000a11c");
const BOB_OWNER = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL_OWNER = userId("00000000-0000-4000-8000-00000000ca20");
const CONTACT_STATUS_ACCEPTED = "accepted";
const CONTACT_STATUS_PENDING = "pending";
type ContactStatus =
  | typeof CONTACT_STATUS_ACCEPTED
  | typeof CONTACT_STATUS_PENDING;

let harness: PgliteHarness;

const it = effectIt.effect;

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

function insertAgent(name: string, ownerUserId: UserId) {
  return takeFirstOrFail(
    harness.db
      .insertInto("agents")
      .values({
        name,
        api_key_id: `${name}-keyid`,
        api_key_secret_hash: `${name}-hash`,
        status: "active",
        owner_user_id: ownerUserId,
      })
      .returning("id"),
  );
}

function insertContact(input: {
  readonly ownerUserId: UserId;
  readonly contactUserId: UserId;
  readonly status: ContactStatus;
}) {
  return harness.db.insertInto("contacts").values({
    owner_user_id: input.ownerUserId,
    contact_user_id: input.contactUserId,
    status: input.status,
  });
}

function insertAcceptedContact(ownerA: UserId, ownerB: UserId) {
  return Effect.all(
    [
      insertContact({
        ownerUserId: ownerA,
        contactUserId: ownerB,
        status: CONTACT_STATUS_ACCEPTED,
      }),
      insertContact({
        ownerUserId: ownerB,
        contactUserId: ownerA,
        status: CONTACT_STATUS_ACCEPTED,
      }),
    ],
    { concurrency: 1 },
  );
}

function visibleFor(callerAgentId: AgentId, callerOwnerUserId: UserId) {
  return visibleAgentIds({
    db: harness.db,
    callerAgentId,
    callerOwnerUserId,
  });
}

function visibleRestrictedTo(
  callerAgentId: AgentId,
  callerOwnerUserId: UserId,
  restrictTo: AgentId[],
) {
  return visibleAgentIds({
    db: harness.db,
    callerAgentId,
    callerOwnerUserId,
    restrictTo,
  });
}

function includesOwnAndSiblingAgents() {
  return Effect.gen(function* () {
    const alice1 = yield* insertAgent("alice-sib1", ALICE_OWNER);
    const alice2 = yield* insertAgent("alice-sib2", ALICE_OWNER);
    yield* insertAgent("carol-far", CAROL_OWNER);

    const ids = yield* visibleFor(alice1.id, ALICE_OWNER);
    const set = new Set(ids);
    expect(set.has(alice1.id)).toBe(true);
    expect(set.has(alice2.id)).toBe(true);
    expect(set.size).toBe(2);
  });
}

function includesAcceptedContactsOnly() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice", ALICE_OWNER);
    const bob = yield* insertAgent("bob", BOB_OWNER);
    const carol = yield* insertAgent("carol", CAROL_OWNER);
    yield* insertAcceptedContact(ALICE_OWNER, BOB_OWNER);

    const ids = yield* visibleFor(alice.id, ALICE_OWNER);
    const set = new Set(ids);
    expect(set.has(alice.id)).toBe(true);
    expect(set.has(bob.id)).toBe(true);
    expect(set.has(carol.id)).toBe(false);
  });
}

function ignoresPendingContacts() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice", ALICE_OWNER);
    const bob = yield* insertAgent("bob", BOB_OWNER);
    yield* insertContact({
      ownerUserId: ALICE_OWNER,
      contactUserId: BOB_OWNER,
      status: CONTACT_STATUS_PENDING,
    });

    const ids = yield* visibleFor(alice.id, ALICE_OWNER);
    const set = new Set(ids);
    expect(set.has(alice.id)).toBe(true);
    expect(set.has(bob.id)).toBe(false);
  });
}

function intersectsWithRestrictTo() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice", ALICE_OWNER);
    const bob = yield* insertAgent("bob", BOB_OWNER);
    const carol = yield* insertAgent("carol", CAROL_OWNER);
    yield* insertAcceptedContact(ALICE_OWNER, BOB_OWNER);

    const ids = yield* visibleRestrictedTo(alice.id, ALICE_OWNER, [
      bob.id,
      carol.id,
    ]);
    const set = new Set(ids);
    expect(set.has(bob.id)).toBe(true);
    expect(set.has(carol.id)).toBe(false);
    expect(set.has(alice.id)).toBe(false);
  });
}

function emptyRestrictToReturnsEmpty() {
  return Effect.gen(function* () {
    const alice = yield* insertAgent("alice", ALICE_OWNER);
    const ids = yield* visibleRestrictedTo(alice.id, ALICE_OWNER, []);
    expect(ids).toEqual([]);
  });
}

describe("visibleAgentIds owner/contact graph", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "includes own agent + sibling agents under same owner",
    includesOwnAndSiblingAgents,
  );
  it(
    "includes agents owned by accepted contacts; excludes non-contacts",
    includesAcceptedContactsOnly,
  );
  it("ignores pending-status contacts", ignoresPendingContacts);
});

describe("visibleAgentIds restrictTo", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it("intersects with restrictTo when provided", intersectsWithRestrictTo);
  it("returns empty when restrictTo is empty", emptyRestrictToReturnsEmpty);
});
