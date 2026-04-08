import { Command } from "commander";
import { request } from "../socket-client.js";

export const statusCommand = new Command("status")
  .description("Show agent connection status and conversation summary")
  .action(async () => {
    try {
      const result = (await request("status")) as {
        agentId: string;
        connected: boolean;
        conversations: number;
      };
      console.log(`Agent ID:       ${result.agentId ?? "none"}`);
      console.log(`Connected:      ${result.connected}`);
      console.log(`Conversations:  ${result.conversations}`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
