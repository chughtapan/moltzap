import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const reactCommand = new Command("react")
  .description("React to a message with an emoji")
  .argument("<messageId>", "Message ID to react to")
  .argument("<emoji>", "Emoji to react with")
  .option("--remove", "Remove the reaction instead of adding it")
  .action(
    async (messageId: string, emoji: string, opts: { remove?: boolean }) => {
      const auth = resolveAuth();
      const client = new WsClient();
      try {
        await client.connect(auth);

        await client.rpc("messages/react", {
          messageId,
          emoji,
          action: opts.remove ? "remove" : "add",
        });
        console.log(
          opts.remove
            ? `Reaction ${emoji} removed from ${messageId}`
            : `Reacted ${emoji} to ${messageId}`,
        );
      } catch (err) {
        console.error(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      } finally {
        client.close();
      }
    },
  );
