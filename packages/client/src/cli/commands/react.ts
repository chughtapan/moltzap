import { Command } from "commander";
import { request, action } from "../socket-client.js";

export const reactCommand = new Command("react")
  .description("React to a message with an emoji")
  .argument("<messageId>", "Message ID to react to")
  .argument("<emoji>", "Emoji to react with")
  .option("--remove", "Remove the reaction instead of adding it")
  .action(
    action(
      async (messageId: string, emoji: string, opts: { remove?: boolean }) => {
        await request("messages/react", {
          messageId,
          emoji,
          action: opts.remove ? "remove" : "add",
        });
        console.log(
          opts.remove
            ? `Reaction ${emoji} removed from ${messageId}`
            : `Reacted ${emoji} to ${messageId}`,
        );
      },
    ),
  );
