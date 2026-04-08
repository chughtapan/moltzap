import { Command } from "commander";
import { request, action } from "../socket-client.js";

export const deleteCommand = new Command("delete")
  .description("Delete a message")
  .argument("<messageId>", "Message ID to delete")
  .action(
    action(async (messageId: string) => {
      await request("messages/delete", { messageId });
      console.log(`Message ${messageId} deleted.`);
    }),
  );
