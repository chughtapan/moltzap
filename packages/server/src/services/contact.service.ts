import { Effect } from "effect";
import type { Db } from "../db/client.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";
import type { ContactRow } from "../db/database.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Contact,
} from "@moltzap/protocol";
import type { ContactId, UserId } from "@moltzap/protocol/identity";

export type ContactsServiceError =
  | ConflictError
  | ForbiddenError
  | NotFoundError;

export interface ContactCreateInput {
  readonly contactUserId: UserId;
  readonly relationship?: string;
}

export interface ContactAcceptResult {
  readonly contact: Contact;
  readonly requesterUserId: UserId;
  readonly transitioned: boolean;
}

const ERR_SELF_ADD = "Cannot add yourself as a contact";
const ERR_DUPLICATE = "Contact already exists";
const ERR_NOT_FOUND = "Contact not found";
const ERR_NOT_RECIPIENT = "Only the recipient can accept the contact request";

export class ContactsService {
  constructor(private readonly db: Db) {}

  list(owner: UserId): Effect.Effect<ReadonlyArray<Contact>, never> {
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
    owner: UserId,
    input: ContactCreateInput,
  ): Effect.Effect<Contact, ContactsServiceError> {
    if (input.contactUserId === owner) {
      return Effect.fail(new ForbiddenError({ message: ERR_SELF_ADD }));
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
          return yield* Effect.fail(
            new ConflictError({ message: ERR_DUPLICATE }),
          );
        }
        return rowToContact(inserted[0]!);
      }),
    );
  }

  accept(
    owner: UserId,
    id: ContactId,
  ): Effect.Effect<ContactAcceptResult, ContactsServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const updated = yield* this.db
          .updateTable("contacts")
          .set({ status: "accepted" })
          .where("id", "=", id)
          .where("contact_user_id", "=", owner)
          .where("status", "=", "pending")
          .returningAll();

        if (updated.length === 0) {
          const existing = yield* this.db
            .selectFrom("contacts")
            .selectAll()
            .where("id", "=", id);
          if (existing.length === 0) {
            return yield* Effect.fail(
              new NotFoundError({ message: ERR_NOT_FOUND }),
            );
          }
          const row = existing[0]!;
          if (row.contact_user_id !== owner) {
            return yield* Effect.fail(
              new ForbiddenError({ message: ERR_NOT_RECIPIENT }),
            );
          }
          return {
            contact: rowToContact(row),
            requesterUserId: row.owner_user_id,
            transitioned: false,
          };
        }

        const row = updated[0]!;
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
        return {
          contact: rowToContact(row),
          requesterUserId: row.owner_user_id,
          transitioned: true,
        };
      }),
    );
  }

  byId(
    owner: UserId,
    id: ContactId,
  ): Effect.Effect<Contact, ContactsServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("contacts")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", owner);
        if (rows.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({ message: ERR_NOT_FOUND }),
          );
        }
        return rowToContact(rows[0]!);
      }),
    );
  }
}

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    contactUserId: row.contact_user_id,
    ...(row.relationship !== null ? { relationship: row.relationship } : {}),
  };
}
