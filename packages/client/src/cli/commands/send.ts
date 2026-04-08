import { Command } from "commander";
import { request, action } from "../socket-client.js";

export const sendCommand = new Command("send")
  .description("Send a message to a conversation or DM")
  .argument("<target>", "Target (agent:<name> or conv:<id>)")
  .argument("<message>", "Message text")
  .option("--reply-to <messageId>", "Reply to a specific message")
  .action(
    action(
      async (target: string, message: string, opts: { replyTo?: string }) => {
        const params: Record<string, unknown> = {
          parts: [{ type: "text", text: message }],
        };
        if (target.startsWith("conv:")) {
          params.conversationId = target.slice(5);
        } else {
          params.to = target;
        }
        if (opts.replyTo) params.replyToId = opts.replyTo;

        const result = (await request("messages/send", params)) as {
          message: { id: string };
        };
        console.log(`Message sent (id: ${result.message.id})`);
      },
    ),
  );
