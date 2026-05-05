import { Effect } from "effect";
import { SqlError } from "@effect/sql/SqlError";
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

const SQL_LABELS = {
  list: "contacts.list",
  addLookup: "contacts.add.lookup",
  addInsert: "contacts.add.insert",
  acceptLookup: "contacts.accept.lookup",
  acceptUpdate: "contacts.accept.update",
  acceptMirror: "contacts.accept.mirror",
  byId: "contacts.byId",
  agentsForUser: "contacts.agentsForUser",
} as const;

const ERR_SELF_ADD = "Cannot add yourself as a contact";
const ERR_DUPLICATE = "Contact already exists";
const ERR_NOT_FOUND = "Contact not found";
const ERR_NOT_RECIPIENT = "Only the recipient can accept the contact request";

type SqlLabel = (typeof SQL_LABELS)[keyof typeof SQL_LABELS];

const tryDb = <T>(
  label: SqlLabel,
  thunk: () => PromiseLike<T>,
): Effect.Effect<T, SqlError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new SqlError({ cause, message: label }),
  });

export class ContactsService {
  constructor(private readonly db: Db) {}

  list(owner: BrandedUserId): Effect.Effect<ReadonlyArray<Contact>, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* tryDb(SQL_LABELS.list, () =>
          this.db
            .selectFrom("contacts")
            .selectAll()
            .where("owner_user_id", "=", owner)
            .execute(),
        );
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
        const existing = yield* tryDb(SQL_LABELS.addLookup, () =>
          this.db
            .selectFrom("contacts")
            .selectAll()
            .where("owner_user_id", "=", owner)
            .where("contact_user_id", "=", input.contactUserId)
            .executeTakeFirst(),
        );
        if (existing !== undefined) {
          return yield* Effect.fail(conflict(ERR_DUPLICATE));
        }
        const inserted = yield* tryDb(SQL_LABELS.addInsert, () =>
          this.db
            .insertInto("contacts")
            .values({
              owner_user_id: owner,
              contact_user_id: input.contactUserId,
              relationship: input.relationship ?? null,
              status: "pending",
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        return rowToContact(inserted);
      }),
    );
  }

  accept(
    owner: BrandedUserId,
    id: BrandedContactId,
  ): Effect.Effect<Contact, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const target = yield* tryDb(SQL_LABELS.acceptLookup, () =>
          this.db
            .selectFrom("contacts")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst(),
        );
        if (target === undefined) {
          return yield* Effect.fail(notFound(ERR_NOT_FOUND));
        }
        if (target.contact_user_id !== owner) {
          return yield* Effect.fail(forbidden(ERR_NOT_RECIPIENT));
        }
        if (target.status === "accepted") {
          return rowToContact(target);
        }
        const updated = yield* tryDb(SQL_LABELS.acceptUpdate, () =>
          this.db
            .updateTable("contacts")
            .set({ status: "accepted" })
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        yield* tryDb(SQL_LABELS.acceptMirror, () =>
          this.db
            .insertInto("contacts")
            .values({
              owner_user_id: target.contact_user_id,
              contact_user_id: target.owner_user_id,
              relationship: target.relationship,
              status: "accepted",
            })
            .onConflict((oc) =>
              oc.columns(["owner_user_id", "contact_user_id"]).doUpdateSet({
                status: "accepted",
              }),
            )
            .execute(),
        );
        return rowToContact(updated);
      }),
    );
  }

  byId(
    owner: BrandedUserId,
    id: BrandedContactId,
  ): Effect.Effect<Contact, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const row = yield* tryDb(SQL_LABELS.byId, () =>
          this.db
            .selectFrom("contacts")
            .selectAll()
            .where("id", "=", id)
            .where("owner_user_id", "=", owner)
            .executeTakeFirst(),
        );
        if (row === undefined) {
          return yield* Effect.fail(notFound(ERR_NOT_FOUND));
        }
        return rowToContact(row);
      }),
    );
  }

  agentsForUser(
    owner: BrandedUserId,
  ): Effect.Effect<ReadonlyArray<string>, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* tryDb(SQL_LABELS.agentsForUser, () =>
          this.db
            .selectFrom("agents")
            .select(["id"])
            .where("owner_user_id", "=", owner)
            .execute(),
        );
        return rows.map((r) => r.id);
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
