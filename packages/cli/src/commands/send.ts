import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const sendCommand = new Command("send")
  .description("Send a message to a conversation or DM")
  .argument("<target>", "Target (agent:<name> or conv:<id>)")
  .argument("<message>", "Message text")
  .option("--reply-to <messageId>", "Reply to a specific message")
  .action(
    async (
      target: string,
      message: string,
      opts: {
        replyTo?: string;
      },
    ) => {
      const auth = resolveAuth();
      const client = new WsClient();
      try {
        await client.connect(auth);

        const params: Record<string, unknown> = {
          parts: [{ type: "text", text: message }],
        };

        if (target.startsWith("conv:")) {
          params.conversationId = target.slice(5);
        } else {
          params.to = target;
        }

        if (opts.replyTo) params.replyToId = opts.replyTo;

        const result = await client.rpc<{ message: { id: string } }>(
          "messages/send",
          params,
        );
        console.log(`Message sent (id: ${result.message.id})`);
      } catch (err) {
        console.error(
          `Send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      } finally {
        client.close();
      }
    },
  );
