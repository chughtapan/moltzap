import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const statusCommand = new Command("status")
  .description("Show agent connection status and conversation summary")
  .action(async () => {
    const client = new WsClient();
    try {
      const hello = await client.connect(resolveAuth());

      const agentId = hello.agentId ?? hello.activeAgentId;
      const totalUnread = Object.values(hello.unreadCounts).reduce(
        (sum, n) => sum + n,
        0,
      );

      console.log(`Agent ID:       ${agentId ?? "none"}`);
      console.log(`Protocol:       ${hello.protocolVersion}`);
      console.log(`Conversations:  ${hello.conversations.length}`);
      console.log(`Unread total:   ${totalUnread}`);
    } catch (err) {
      console.error(
        `Status failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });
