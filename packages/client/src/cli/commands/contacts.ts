import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";
import type { Contact } from "@moltzap/protocol";
import { request } from "../socket-client.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);

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
    request("contacts/list", {}) as Effect.Effect<
      { contacts: Contact[] },
      Error
    >,
    (r) => {
      if (json) {
        console.log(JSON.stringify(r.contacts, null, 2));
        return;
      }
      if (r.contacts.length === 0) {
        console.log("No contacts found.");
        return;
      }
      for (const c of r.contacts) {
        const rel = c.relationship ? ` (${c.relationship})` : "";
        console.log(`  ${c.id}  ${c.contactUserId}  ${c.source}${rel}`);
      }
    },
  ),
).pipe(Command.withDescription("List contacts"));

const identifierArg = Args.text({ name: "identifier" }).pipe(
  Args.withDescription("Phone number (+E.164) or user ID"),
);

const addContact = Command.make(
  "add",
  { identifier: identifierArg },
  ({ identifier }) => {
    const params: Record<string, string> = {};
    if (identifier.startsWith("+")) {
      params.phone = identifier;
      params.source = "phone";
    } else {
      params.contactUserId = identifier;
      params.source = "manual";
    }
    return wrap(
      request("contacts/add", params) as Effect.Effect<
        { contact: Contact },
        Error
      >,
      (r) => {
        console.log(`Contact added (id: ${r.contact.id})`);
      },
    );
  },
).pipe(Command.withDescription("Add a contact by phone number or user ID"));

const contactIdArg = Args.text({ name: "contactId" }).pipe(
  Args.withDescription("Contact ID"),
);

const acceptContact = Command.make(
  "accept",
  { contactId: contactIdArg },
  ({ contactId }) =>
    wrap(
      request("contacts/accept", { contactId }) as Effect.Effect<
        { contact: Contact },
        Error
      >,
      (r) => {
        console.log(`Contact accepted: ${r.contact.id}`);
      },
    ),
).pipe(Command.withDescription("Accept a contact request"));

const blockContact = Command.make(
  "block",
  { contactId: contactIdArg },
  ({ contactId }) =>
    wrap(request("contacts/block", { contactId }), () => {
      console.log(`Contact ${contactId} blocked.`);
    }),
).pipe(Command.withDescription("Block a contact"));

const removeContact = Command.make(
  "remove",
  { contactId: contactIdArg },
  ({ contactId }) =>
    wrap(request("contacts/remove", { contactId }), () => {
      console.log(`Contact ${contactId} removed.`);
    }),
).pipe(Command.withDescription("Remove a contact"));

/**
 * `moltzap contacts [list|add|accept|block|remove]` — contact CRUD over the
 * local Unix socket. Addresses by phone (+E.164 prefix) or explicit user id.
 */
export const contactsCommand = Command.make("contacts", {}, () =>
  listContacts.handler({ json: false }),
).pipe(
  Command.withDescription("Manage contacts"),
  Command.withSubcommands([
    listContacts,
    addContact,
    acceptContact,
    blockContact,
    removeContact,
  ]),
);
