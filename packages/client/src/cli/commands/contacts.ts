import { Command } from "commander";
import { request, action } from "../socket-client.js";
import type { Contact } from "@moltzap/protocol";

export const contactsCommand = new Command("contacts").description(
  "Manage contacts",
);

contactsCommand
  .command("list")
  .description("List contacts")
  .option("--json", "Output as JSON")
  .action(
    action(async (opts: { json?: boolean }) => {
      const result = (await request("contacts/list", {})) as {
        contacts: Contact[];
      };

      if (opts.json) {
        console.log(JSON.stringify(result.contacts, null, 2));
        return;
      }
      if (result.contacts.length === 0) {
        console.log("No contacts found.");
        return;
      }
      for (const c of result.contacts) {
        const rel = c.relationship ? ` (${c.relationship})` : "";
        console.log(`  ${c.id}  ${c.contactUserId}  ${c.source}${rel}`);
      }
    }),
  );

contactsCommand
  .command("add")
  .description("Add a contact by phone number or user ID")
  .argument("<identifier>", "Phone number (+E.164) or user ID")
  .action(
    action(async (identifier: string) => {
      const params: Record<string, string> = {};
      if (identifier.startsWith("+")) {
        params.phone = identifier;
        params.source = "phone";
      } else {
        params.contactUserId = identifier;
        params.source = "manual";
      }
      const result = (await request("contacts/add", params)) as {
        contact: Contact;
      };
      console.log(`Contact added (id: ${result.contact.id})`);
    }),
  );

contactsCommand
  .command("accept")
  .description("Accept a contact request")
  .argument("<contactId>", "Contact ID to accept")
  .action(
    action(async (contactId: string) => {
      const result = (await request("contacts/accept", { contactId })) as {
        contact: Contact;
      };
      console.log(`Contact accepted: ${result.contact.id}`);
    }),
  );

contactsCommand
  .command("block")
  .description("Block a contact")
  .argument("<contactId>", "Contact ID to block")
  .action(
    action(async (contactId: string) => {
      await request("contacts/block", { contactId });
      console.log(`Contact ${contactId} blocked.`);
    }),
  );

contactsCommand
  .command("remove")
  .description("Remove a contact")
  .argument("<contactId>", "Contact ID to remove")
  .action(
    action(async (contactId: string) => {
      await request("contacts/remove", { contactId });
      console.log(`Contact ${contactId} removed.`);
    }),
  );
