import { Command } from "commander";
import { withService } from "../with-service.js";
import type { Contact } from "@moltzap/protocol";

export const contactsCommand = new Command("contacts").description(
  "Manage contacts",
);

contactsCommand
  .command("list")
  .description("List contacts")
  .option("--status <status>", "Filter by status (pending, accepted, blocked)")
  .option("--json", "Output as JSON")
  .action(async (opts: { status?: string; json?: boolean }) => {
    await withService(async (service) => {
      const params: Record<string, unknown> = {};
      if (opts.status) params.status = opts.status;

      const result = (await service.sendRpc("contacts/list", params)) as {
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
        const requester = c.requesterName ?? c.requesterPhone ?? c.requesterId;
        const target = c.targetName ?? c.targetPhone ?? c.targetId;
        console.log(`  ${c.id}  ${c.status}  ${requester} -> ${target}`);
      }
    });
  });

contactsCommand
  .command("add")
  .description("Add a contact by phone number or user ID")
  .argument("<identifier>", "Phone number (+E.164) or user ID")
  .action(async (identifier: string) => {
    await withService(async (service) => {
      const params: Record<string, string> = {};
      if (identifier.startsWith("+")) {
        params.phone = identifier;
      } else {
        params.userId = identifier;
      }

      const result = (await service.sendRpc("contacts/add", params)) as {
        contactId: string;
        status: string;
      };
      console.log(
        `Contact request sent (id: ${result.contactId}, status: ${result.status})`,
      );
    });
  });

contactsCommand
  .command("accept")
  .description("Accept a contact request")
  .argument("<contactId>", "Contact ID to accept")
  .action(async (contactId: string) => {
    await withService(async (service) => {
      const result = (await service.sendRpc("contacts/accept", {
        contactId,
      })) as { contact: Contact };
      console.log(`Contact accepted: ${result.contact.id}`);
    });
  });

contactsCommand
  .command("block")
  .description("Block a contact")
  .argument("<contactId>", "Contact ID to block")
  .action(async (contactId: string) => {
    await withService(async (service) => {
      await service.sendRpc("contacts/block", { contactId });
      console.log(`Contact ${contactId} blocked.`);
    });
  });

contactsCommand
  .command("remove")
  .description("Remove a contact")
  .argument("<contactId>", "Contact ID to remove")
  .action(async (contactId: string) => {
    await withService(async (service) => {
      await service.sendRpc("contacts/remove", { contactId });
      console.log(`Contact ${contactId} removed.`);
    });
  });
