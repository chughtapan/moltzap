import { Effect } from "effect";
import type { Db } from "../db/client.js";
import {
  notFound,
  forbidden,
  conflict,
  type RpcFailure,
} from "../runtime/index.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";
import type { ContactRow } from "../db/database.js";
import {
  contactId,
  userId,
  type Contact,
  type Static,
} from "@moltzap/protocol";
import { ContactId, UserId } from "@moltzap/protocol/schemas/primitives";

type BrandedContactId = Static<typeof ContactId>;
type BrandedUserId = Static<typeof UserId>;

export interface ContactCreateInput {
  readonly contactUserId: BrandedUserId;
  readonly relationship?: string;
}

const ERR_SELF_ADD = "Cannot add yourself as a contact";
const ERR_DUPLICATE = "Contact already exists";
const ERR_NOT_FOUND = "Contact not found";
const ERR_NOT_RECIPIENT = "Only the recipient can accept the contact request";

export class ContactsService {
  constructor(private readonly db: Db) {}

  list(owner: BrandedUserId): Effect.Effect<ReadonlyArray<Contact>, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("contacts")
          .selectAll()
          .where("owner_user_id", "=", owner);
        return rows.map(rowToContact);
      }),
    );
  }

  add(
    owner: BrandedUserId,
    input: ContactCreateInput,
  ): Effect.Effect<Contact, RpcFailure> {
    if (input.contactUserId === owner) {
      return Effect.fail(forbidden(ERR_SELF_ADD));
    }
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const inserted = yield* this.db
          .insertInto("contacts")
          .values({
            owner_user_id: owner,
            contact_user_id: input.contactUserId,
            relationship: input.relationship ?? null,
            status: "pending",
          })
          .onConflict((oc) =>
            oc.columns(["owner_user_id", "contact_user_id"]).doNothing(),
          )
          .returningAll();
        if (inserted.length === 0) {
          return yield* Effect.fail(conflict(ERR_DUPLICATE));
        }
        return rowToContact(inserted[0]!);
      }),
    );
  }

  accept(
    owner: BrandedUserId,
    id: BrandedContactId,
  ): Effect.Effect<Contact, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const target = yield* this.db
          .selectFrom("contacts")
          .selectAll()
          .where("id", "=", id);
        if (target.length === 0) {
          return yield* Effect.fail(notFound(ERR_NOT_FOUND));
        }
        const row = target[0]!;
        if (row.contact_user_id !== owner) {
          return yield* Effect.fail(forbidden(ERR_NOT_RECIPIENT));
        }
        if (row.status === "accepted") {
          return rowToContact(row);
        }
        const updated = yield* this.db
          .updateTable("contacts")
          .set({ status: "accepted" })
          .where("id", "=", id)
          .returningAll();
        yield* this.db
          .insertInto("contacts")
          .values({
            owner_user_id: row.contact_user_id,
            contact_user_id: row.owner_user_id,
            relationship: row.relationship,
            status: "accepted",
          })
          .onConflict((oc) =>
            oc.columns(["owner_user_id", "contact_user_id"]).doUpdateSet({
              status: "accepted",
            }),
          );
        return rowToContact(updated[0]!);
      }),
    );
  }

  byId(
    owner: BrandedUserId,
    id: BrandedContactId,
  ): Effect.Effect<Contact, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("contacts")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", owner);
        if (rows.length === 0) {
          return yield* Effect.fail(notFound(ERR_NOT_FOUND));
        }
        return rowToContact(rows[0]!);
      }),
    );
  }
}

function rowToContact(row: ContactRow): Contact {
  return {
    id: contactId(row.id),
    contactUserId: userId(row.contact_user_id),
    ...(row.relationship !== null ? { relationship: row.relationship } : {}),
  };
}
