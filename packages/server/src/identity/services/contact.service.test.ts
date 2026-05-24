import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit } from "effect";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@moltzap/protocol";
import { userId, wireErrorFromInstance } from "@moltzap/protocol/testing";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { ContactsService } from "./contact.service.js";

const ALICE = userId("00000000-0000-4000-8000-00000000a11c");
const BOB = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = userId("00000000-0000-4000-8000-00000000ca20");

let harness: PgliteHarness;
let db: PgliteHarness["db"];

const it = effectIt.effect;

function freshDb(): Effect.Effect<void, unknown> {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
        db = created.db;
      }),
    ),
    Effect.withSpan("ContactsServiceTest.freshDb"),
  );
}

function rpcFailureCode(exit: Exit.Exit<unknown, unknown>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return wireErrorFromInstance(failure.value)?.code ?? null;
}

function createsPendingContact() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const contact = yield* svc.add(ALICE, { contactUserId: BOB });
    expect(contact.contactUserId).toBe(BOB);
  });
}

function rejectsSelfAdd() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const exit = yield* Effect.exit(svc.add(ALICE, { contactUserId: ALICE }));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function rejectsDuplicateAdd() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    yield* svc.add(ALICE, { contactUserId: BOB });
    const exit = yield* Effect.exit(svc.add(ALICE, { contactUserId: BOB }));
    expect(rpcFailureCode(exit)).toBe(ConflictError.code);
  });
}

function acceptsPendingContact() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const requested = yield* svc.add(ALICE, { contactUserId: BOB });
    const result = yield* svc.accept(BOB, requested.id);
    expect(result.transitioned).toBe(true);
    expect(result.requesterUserId).toBe(ALICE);
    const bobContacts = yield* svc.list(BOB, {});
    expect(bobContacts.contacts.map((c) => c.contactUserId)).toContain(ALICE);
  });
}

function rejectsUnknownContactAccept() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const exit = yield* Effect.exit(
      svc.accept(BOB, "00000000-0000-4000-8000-000000000404" as never),
    );
    expect(rpcFailureCode(exit)).toBe(NotFoundError.code);
  });
}

function rejectsRequesterAcceptingOwnRequest() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const requested = yield* svc.add(ALICE, { contactUserId: BOB });
    const exit = yield* Effect.exit(svc.accept(ALICE, requested.id));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function rejectsUnrelatedAcceptor() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const requested = yield* svc.add(ALICE, { contactUserId: BOB });
    const exit = yield* Effect.exit(svc.accept(CAROL, requested.id));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function acceptsConcurrentlyOnce() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const requested = yield* svc.add(ALICE, { contactUserId: BOB });
    const [a, b] = yield* Effect.all(
      [svc.accept(BOB, requested.id), svc.accept(BOB, requested.id)],
      { concurrency: 2 },
    );
    const transitioned = [a.transitioned, b.transitioned];
    expect(transitioned.filter((t) => t === true)).toHaveLength(1);
    expect(transitioned.filter((t) => t === false)).toHaveLength(1);
    expect(a.requesterUserId).toBe(ALICE);
    expect(b.requesterUserId).toBe(ALICE);
  });
}

function reacceptReturnsNotTransitioned() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const requested = yield* svc.add(ALICE, { contactUserId: BOB });
    yield* svc.accept(BOB, requested.id);
    const second = yield* svc.accept(BOB, requested.id);
    expect(second.transitioned).toBe(false);
    expect(second.requesterUserId).toBe(ALICE);
  });
}

function byIdReturnsOwnedRow() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const created = yield* svc.add(ALICE, { contactUserId: BOB });
    const fetched = yield* svc.byId(ALICE, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.contactUserId).toBe(BOB);
  });
}

function byIdDoesNotLeakOtherOwnersRows() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const created = yield* svc.add(ALICE, { contactUserId: BOB });
    const exit = yield* Effect.exit(svc.byId(CAROL, created.id));
    expect(rpcFailureCode(exit)).toBe(NotFoundError.code);
  });
}

function listsOnlyCallerRows() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    yield* svc.add(ALICE, { contactUserId: BOB });
    yield* svc.add(ALICE, { contactUserId: CAROL });
    yield* svc.add(BOB, { contactUserId: CAROL });
    const aliceList = yield* svc.list(ALICE, {});
    const bobList = yield* svc.list(BOB, {});
    expect(aliceList.contacts.map((c) => c.contactUserId).sort()).toEqual(
      [BOB, CAROL].sort(),
    );
    expect(bobList.contacts.map((c) => c.contactUserId)).toEqual([CAROL]);
  });
}

const COLLEAGUE_RELATIONSHIP = "colleague";

function roundTripsRelationship() {
  return Effect.gen(function* () {
    const svc = new ContactsService(db);
    const created = yield* svc.add(ALICE, {
      contactUserId: BOB,
      relationship: COLLEAGUE_RELATIONSHIP,
    });
    expect(created.relationship).toBe(COLLEAGUE_RELATIONSHIP);
    const list = yield* svc.list(ALICE, {});
    expect(list.contacts[0]!.relationship).toBe(COLLEAGUE_RELATIONSHIP);
  });
}

describe("ContactsService", () => {
  beforeEach(() => Effect.runPromise(freshDb()), PGLITE_HOOK_TIMEOUT_MS);

  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  describe("add", () => {
    it("creates a pending contact", createsPendingContact);
    it("rejects self-add", rejectsSelfAdd);
    it("rejects duplicate add (Alice→Bob already exists)", rejectsDuplicateAdd);
  });

  describe("accept", () => {
    it(
      "transitions pending → accepted, exposes requesterUserId, mirrors row",
      acceptsPendingContact,
    );
    it("notFound when contact id is unknown", rejectsUnknownContactAccept);
    it(
      "forbidden when caller is not the recipient (Alice tries to accept her own request)",
      rejectsRequesterAcceptingOwnRequest,
    );
    it(
      "forbidden when an unrelated user tries to accept",
      rejectsUnrelatedAcceptor,
    );
    it(
      "concurrent accepts: exactly one observes transitioned: true",
      acceptsConcurrentlyOnce,
    );
    it(
      "re-accepting an already-accepted contact returns transitioned: false",
      reacceptReturnsNotTransitioned,
    );
  });

  describe("byId", () => {
    it("returns the row when the caller owns it", byIdReturnsOwnedRow);
    it(
      "notFound when the caller does not own the row (existence not leaked)",
      byIdDoesNotLeakOtherOwnersRows,
    );
  });

  describe("list", () => {
    it("returns only the caller's rows", listsOnlyCallerRows);
  });

  describe("relationship", () => {
    it("round-trips through add → list", roundTripsRelationship);
  });
});
