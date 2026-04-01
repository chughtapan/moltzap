import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const deleteCommand = new Command("delete")
  .description("Delete a message")
  .argument("<messageId>", "Message ID to delete")
  .action(async (messageId: string) => {
    const auth = resolveAuth();
    const client = new WsClient();
    try {
      await client.connect(auth);

      await client.rpc("messages/delete", { messageId });
      console.log(`Message ${messageId} deleted.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });
