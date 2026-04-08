import { Command } from "commander";
import { request } from "../socket-client.js";

export const deleteCommand = new Command("delete")
  .description("Delete a message")
  .argument("<messageId>", "Message ID to delete")
  .action(async (messageId: string) => {
    try {
      await request("messages/delete", { messageId });
      console.log(`Message ${messageId} deleted.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
