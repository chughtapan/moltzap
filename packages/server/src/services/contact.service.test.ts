import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { ErrorCodes, userId } from "@moltzap/protocol";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import { ContactsService } from "./contact.service.js";
import { RpcFailure } from "../runtime/index.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../test-utils/index.js";

const ALICE = userId("00000000-0000-4000-8000-00000000a11c");
const BOB = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = userId("00000000-0000-4000-8000-00000000ca20");

// Compatibility alias so the body of the suite (which references
// `db: Kysely<Database>` directly) keeps reading naturally after the
// freshDb-to-harness migration.
let harness: PgliteHarness;
let db: Kysely<Database>;

function rpcFailureCode(exit: Exit.Exit<unknown, RpcFailure>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return failure.value.code;
}

describe("ContactsService", () => {
  beforeEach(async () => {
    harness = await makePgliteHarness();
    db = harness.db;
  }, PGLITE_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await harness.close();
  }, PGLITE_HOOK_TIMEOUT_MS);

  describe("add", () => {
    it("creates a pending contact", async () => {
      const svc = new ContactsService(db);
      const contact = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      expect(contact.contactUserId).toBe(BOB);
    });

    it("rejects self-add", async () => {
      const svc = new ContactsService(db);
      const exit = await Effect.runPromise(
        Effect.exit(svc.add(ALICE, { contactUserId: ALICE })),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("rejects duplicate add (Alice→Bob already exists)", async () => {
      const svc = new ContactsService(db);
      await Effect.runPromise(svc.add(ALICE, { contactUserId: BOB }));
      const exit = await Effect.runPromise(
        Effect.exit(svc.add(ALICE, { contactUserId: BOB })),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Conflict);
    });
  });

  describe("accept", () => {
    it("transitions pending → accepted, exposes requesterUserId, mirrors row", async () => {
      const svc = new ContactsService(db);
      const requested = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const result = await Effect.runPromise(svc.accept(BOB, requested.id));
      expect(result.transitioned).toBe(true);
      expect(result.requesterUserId).toBe(ALICE);
      const bobContacts = await Effect.runPromise(svc.list(BOB));
      expect(bobContacts.map((c) => c.contactUserId)).toContain(ALICE);
    });

    it("notFound when contact id is unknown", async () => {
      const svc = new ContactsService(db);
      const exit = await Effect.runPromise(
        Effect.exit(
          svc.accept(BOB, "00000000-0000-4000-8000-000000000404" as never),
        ),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.NotFound);
    });

    it("forbidden when caller is not the recipient (Alice tries to accept her own request)", async () => {
      const svc = new ContactsService(db);
      const requested = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const exit = await Effect.runPromise(
        Effect.exit(svc.accept(ALICE, requested.id)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("forbidden when an unrelated user tries to accept", async () => {
      const svc = new ContactsService(db);
      const requested = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const exit = await Effect.runPromise(
        Effect.exit(svc.accept(CAROL, requested.id)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("concurrent accepts: exactly one observes transitioned: true", async () => {
      const svc = new ContactsService(db);
      const requested = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const [a, b] = await Effect.runPromise(
        Effect.all(
          [svc.accept(BOB, requested.id), svc.accept(BOB, requested.id)],
          {
            concurrency: "unbounded",
          },
        ),
      );
      const transitioned = [a.transitioned, b.transitioned];
      expect(transitioned.filter((t) => t === true)).toHaveLength(1);
      expect(transitioned.filter((t) => t === false)).toHaveLength(1);
      expect(a.requesterUserId).toBe(ALICE);
      expect(b.requesterUserId).toBe(ALICE);
    });

    it("re-accepting an already-accepted contact returns transitioned: false", async () => {
      const svc = new ContactsService(db);
      const requested = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      await Effect.runPromise(svc.accept(BOB, requested.id));
      const second = await Effect.runPromise(svc.accept(BOB, requested.id));
      expect(second.transitioned).toBe(false);
      expect(second.requesterUserId).toBe(ALICE);
    });
  });

  describe("byId", () => {
    it("returns the row when the caller owns it", async () => {
      const svc = new ContactsService(db);
      const created = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const fetched = await Effect.runPromise(svc.byId(ALICE, created.id));
      expect(fetched.id).toBe(created.id);
      expect(fetched.contactUserId).toBe(BOB);
    });

    it("notFound when the caller does not own the row (existence not leaked)", async () => {
      const svc = new ContactsService(db);
      const created = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB }),
      );
      const exit = await Effect.runPromise(
        Effect.exit(svc.byId(CAROL, created.id)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.NotFound);
    });
  });

  describe("list", () => {
    it("returns only the caller's rows", async () => {
      const svc = new ContactsService(db);
      await Effect.runPromise(svc.add(ALICE, { contactUserId: BOB }));
      await Effect.runPromise(svc.add(ALICE, { contactUserId: CAROL }));
      await Effect.runPromise(svc.add(BOB, { contactUserId: CAROL }));
      const aliceList = await Effect.runPromise(svc.list(ALICE));
      const bobList = await Effect.runPromise(svc.list(BOB));
      expect(aliceList.map((c) => c.contactUserId).sort()).toEqual(
        [BOB, CAROL].sort(),
      );
      expect(bobList.map((c) => c.contactUserId)).toEqual([CAROL]);
    });
  });

  describe("relationship", () => {
    it("round-trips through add → list", async () => {
      const svc = new ContactsService(db);
      const created = await Effect.runPromise(
        svc.add(ALICE, { contactUserId: BOB, relationship: "colleague" }),
      );
      expect(created.relationship).toBe("colleague");
      const list = await Effect.runPromise(svc.list(ALICE));
      expect(list[0]!.relationship).toBe("colleague");
    });
  });
});
