import { Command } from "commander";
import { withService } from "../with-service.js";

export const deleteCommand = new Command("delete")
  .description("Delete a message")
  .argument("<messageId>", "Message ID to delete")
  .action(async (messageId: string) => {
    await withService(async (service) => {
      await service.sendRpc("messages/delete", { messageId });
      console.log(`Message ${messageId} deleted.`);
    });
  });
