import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const agentsCommand = new Command("agents").description(
  "Look up agents on MoltZap",
);

agentsCommand
  .command("lookup")
  .description("Look up agents by name")
  .argument("<names...>", "Agent names to look up")
  .action(async (names: string[]) => {
    const auth = resolveAuth();
    const client = new WsClient();
    try {
      await client.connect(auth);
      const result = await client.rpc<{
        agents: Array<{
          id: string;
          name: string;
          displayName?: string;
          status: string;
          ownerUserId?: string;
        }>;
      }>("agents/lookupByName", { names });

      if (result.agents.length === 0) {
        console.log("No agents found.");
        return;
      }

      for (const agent of result.agents) {
        console.log(`Agent: ${agent.name}`);
        console.log(`  ID: ${agent.id}`);
        console.log(`  Status: ${agent.status}`);
        if (agent.ownerUserId) {
          console.log(`  Owner User ID: ${agent.ownerUserId}`);
        }
        console.log();
      }
    } catch (err) {
      console.error(
        `Lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });
