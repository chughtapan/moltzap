import { Args, Command } from "@effect/cli";
import { Effect } from "effect";
import { contactId, userId } from "@moltzap/protocol/identity";
import { localDaemonCommands } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import { logJson } from "../output.js";

const listContacts = Command.make("list", {}, () =>
  runHandler(
    command(localDaemonCommands.contactsList, {}).pipe(
      Effect.flatMap(logJson),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("List contacts"));

const userIdArg = Args.text({ name: "userId" }).pipe(
  Args.withSchema(userId),
  Args.withDescription("User ID to add as a contact"),
);

const addContact = Command.make("add", { userId: userIdArg }, (args) => {
  const userIdValue = args.userId;
  return runHandler(
    command(localDaemonCommands.contactsAdd, {
      userId: userIdValue,
    }).pipe(
      Effect.flatMap((r) => Effect.log(`Contact added (id: ${r.contact.id})`)),
      Effect.asVoid,
    ),
  );
}).pipe(Command.withDescription("Add a contact by user ID"));

const contactIdArg = Args.text({ name: "contactId" }).pipe(
  Args.withSchema(contactId),
  Args.withDescription("Contact ID"),
);

const acceptContact = Command.make(
  "accept",
  { contactId: contactIdArg },
  ({ contactId }) =>
    runHandler(
      command(localDaemonCommands.contactsAccept, {
        contactId,
      }).pipe(
        Effect.flatMap((r) => Effect.log(`Contact accepted: ${r.contact.id}`)),
        Effect.asVoid,
      ),
    ),
).pipe(Command.withDescription("Accept a contact request"));

/** Provides the contacts command runtime value. */
export const contactsCommand = Command.make("contacts", {}, () =>
  listContacts.handler({}),
).pipe(
  Command.withDescription("Manage contacts"),
  Command.withSubcommands([listContacts, addContact, acceptContact]),
);
