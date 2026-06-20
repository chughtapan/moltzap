import { Effect } from "effect";
import type { Db } from "#db";
import { catchSqlErrorAsDefect } from "#db";
import type { ContactRow } from "#db";
import {
  ConflictError,
  DEFAULT_PAGE_LIMIT,
  ForbiddenError,
} from "@moltzap/protocol/rpc";
import { ContactNotFoundError, ContactsAdd } from "@moltzap/protocol/identity";
import type { ListCursor, ResultOf } from "@moltzap/protocol/rpc";
import type { ContactId, UserId } from "@moltzap/protocol/identity";
import {
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
  type InvalidCursorError,
} from "#db";

type Contact = ResultOf<typeof ContactsAdd>["contact"];

export interface ContactsListInput {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ContactsListPage {
  readonly contacts: readonly Contact[];
  readonly nextCursor?: ListCursor;
}

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

  list(
    owner: UserId,
    input: ContactsListInput,
  ): Effect.Effect<ContactsListPage, InvalidCursorError> {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    return Effect.gen(this, function* () {
      const pos =
        input.cursor === undefined
          ? undefined
          : yield* decodeListCursor(input.cursor);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          let query = this.db
            .selectFrom("contacts")
            .selectAll()
            .where("owner_user_id", "=", owner);
          if (pos !== undefined) {
            query = query.where((eb) =>
              keysetWhere(
                eb,
                { sortKey: sortKeyExpr(eb, "created_at"), id: "id" },
                pos,
              ),
            );
          }
          const rows = yield* query
            .orderBy((eb) => sortKeyExpr(eb, "created_at"), "desc")
            .orderBy("id", "asc")
            .limit(limit + 1);
          const { page, nextCursor } = paginate(
            rows,
            limit,
            positionOfContactRow,
          );
          return {
            contacts: page.map(rowToContact),
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          };
        }),
      );
    });
  }

  add(
    owner: UserId,
    input: ContactCreateInput,
  ): Effect.Effect<Contact, ForbiddenError | ConflictError> {
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
  ): Effect.Effect<ContactAcceptResult, ContactNotFoundError | ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const updated = yield* this.markPendingContactAccepted(owner, id);
        if (updated.length === 0) {
          return yield* this.resolveAlreadyAcceptedContact(owner, id);
        }

        const row = updated[0]!;
        yield* this.upsertMirroredAcceptedContact(row);
        return {
          contact: rowToContact(row),
          requesterUserId: row.owner_user_id,
          transitioned: true,
        };
      }),
    );
  }

  private markPendingContactAccepted(owner: UserId, id: ContactId) {
    return this.db
      .updateTable("contacts")
      .set({ status: "accepted" })
      .where("id", "=", id)
      .where("contact_user_id", "=", owner)
      .where("status", "=", "pending")
      .returningAll();
  }

  private resolveAlreadyAcceptedContact(owner: UserId, id: ContactId) {
    return Effect.gen(this, function* () {
      const existing = yield* this.db
        .selectFrom("contacts")
        .selectAll()
        .where("id", "=", id);
      if (existing.length === 0) {
        return yield* Effect.fail(
          new ContactNotFoundError({ message: ERR_NOT_FOUND }),
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
    });
  }

  private upsertMirroredAcceptedContact(row: ContactRow) {
    return this.db
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
  }

  byId(
    owner: UserId,
    id: ContactId,
  ): Effect.Effect<Contact, ContactNotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("contacts")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", owner);
        if (rows.length === 0) {
          return yield* Effect.fail(
            new ContactNotFoundError({ message: ERR_NOT_FOUND }),
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

// `created_at` is the ordering column only; never projected onto `Contact`.
function positionOfContactRow(row: ContactRow): {
  readonly sortKey: string;
  readonly id: string;
} {
  return { sortKey: row.created_at.toISOString(), id: row.id };
}
