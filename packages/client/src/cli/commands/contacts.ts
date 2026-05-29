import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";
import { type Contact } from "@moltzap/protocol";
import type { ContactId, UserId } from "@moltzap/protocol/identity";
import { request } from "../socket-client.js";

import { ContactsAccept, ContactsAdd, ContactsList } from "@moltzap/protocol";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);
const JSON_INDENT_SPACES = 2;

const wrap = <A>(
  effect: Effect.Effect<A, Error>,
  onSuccess: (value: A) => void,
): Effect.Effect<void> =>
  effect.pipe(
    Effect.tap((value) => Effect.sync(() => onSuccess(value))),
    Effect.asVoid,
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }),
    ),
  );

const listContacts = Command.make("list", { json: jsonOption }, ({ json }) =>
  wrap(
    request(ContactsList, {}) as Effect.Effect<
      { contacts: Contact[]; nextCursor?: string },
      Error
    >,
    (r) => {
      if (json) {
        // Emit the full result (incl. nextCursor) so a machine consumer
        // can detect a truncated page; `r.contacts` alone would hide it.
        console.log(JSON.stringify(r, null, JSON_INDENT_SPACES));
        return;
      }
      if (r.contacts.length === 0) {
        console.log("No contacts found.");
        return;
      }
      for (const c of r.contacts) {
        const rel = c.relationship ? ` (${c.relationship})` : "";
        console.log(`  ${c.id}  ${c.contactUserId}${rel}`);
      }
      // Signal a truncated page so users don't mistake it for the full list.
      if (r.nextCursor !== undefined) {
        console.log(
          `Showing first ${r.contacts.length} — more results available.`,
        );
      }
    },
  ),
).pipe(Command.withDescription("List contacts"));

const userIdArg = Args.text({ name: "userId" }).pipe(
  Args.withDescription("User ID to add as a contact"),
);

const addContact = Command.make("add", { userId: userIdArg }, ({ userId: u }) =>
  wrap(
    request(ContactsAdd, {
      contactUserId: u as UserId,
    }) as Effect.Effect<{ contact: Contact }, Error>,
    (r) => {
      console.log(`Contact added (id: ${r.contact.id})`);
    },
  ),
).pipe(Command.withDescription("Add a contact by user ID"));

const contactIdArg = Args.text({ name: "contactId" }).pipe(
  Args.withDescription("Contact ID"),
);

const acceptContact = Command.make(
  "accept",
  { contactId: contactIdArg },
  ({ contactId }) =>
    wrap(
      request(ContactsAccept, {
        contactId: contactId as ContactId,
      }) as Effect.Effect<{ contact: Contact }, Error>,
      (r) => {
        console.log(`Contact accepted: ${r.contact.id}`);
      },
    ),
).pipe(Command.withDescription("Accept a contact request"));

export const contactsCommand = Command.make("contacts", {}, () =>
  listContacts.handler({ json: false }),
).pipe(
  Command.withDescription("Manage contacts"),
  Command.withSubcommands([listContacts, addContact, acceptContact]),
);
