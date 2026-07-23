import { Args, Command } from "@effect/cli";
import { Effect } from "effect";
import { ContactId, UserId } from "@moltzap/protocol/identity";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import { logJson } from "../output.js";

// safer-arch-ignore folder-explicit-api-required: the CLI entrypoint deliberately composes private one-command-per-file leaves; this folder is not a reusable API.
const listContacts = Command.make("list", {}, () =>
  runHandler(
    command(LocalDaemonCommands.ContactsList, {}).pipe(
      Effect.flatMap(logJson),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("List contacts"));

const userIdArg = Args.text({ name: "userId" }).pipe(
  Args.withSchema(UserId),
  Args.withDescription("User ID to add as a contact"),
);

const addContact = Command.make("add", { userId: userIdArg }, ({ userId: u }) =>
  runHandler(
    command(LocalDaemonCommands.ContactsAdd, {
      userId: u,
    }).pipe(
      Effect.flatMap((r) => Effect.log(`Contact added (id: ${r.contact.id})`)),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("Add a contact by user ID"));

const contactIdArg = Args.text({ name: "contactId" }).pipe(
  Args.withSchema(ContactId),
  Args.withDescription("Contact ID"),
);

const acceptContact = Command.make(
  "accept",
  { contactId: contactIdArg },
  ({ contactId }) =>
    runHandler(
      command(LocalDaemonCommands.ContactsAccept, {
        contactId,
      }).pipe(
        Effect.flatMap((r) => Effect.log(`Contact accepted: ${r.contact.id}`)),
        Effect.asVoid,
      ),
    ),
).pipe(Command.withDescription("Accept a contact request"));

export const contactsCommand = Command.make("contacts", {}, () =>
  listContacts.handler({}),
).pipe(
  Command.withDescription("Manage contacts"),
  Command.withSubcommands([listContacts, addContact, acceptContact]),
);
