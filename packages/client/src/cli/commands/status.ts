import { Command } from "commander";
import { request, action } from "../socket-client.js";

export const statusCommand = new Command("status")
  .description("Show agent connection status and conversation summary")
  .action(
    action(async () => {
      const result = (await request("status")) as {
        agentId: string;
        connected: boolean;
        conversations: number;
      };
      console.log(`Agent ID:       ${result.agentId ?? "none"}`);
      console.log(`Connected:      ${result.connected}`);
      console.log(`Conversations:  ${result.conversations}`);
    }),
  );
