import { Command } from "commander";
import { withService } from "../with-service.js";

export const statusCommand = new Command("status")
  .description("Show agent connection status and conversation summary")
  .action(async () => {
    await withService(async (service, hello) => {
      const totalUnread = Object.values(hello.unreadCounts ?? {}).reduce(
        (sum: number, n: number) => sum + n,
        0,
      );

      console.log(`Agent ID:       ${service.ownAgentId ?? "none"}`);
      console.log(`Conversations:  ${service.getConversations().length}`);
      console.log(`Unread total:   ${totalUnread}`);
    });
  });
