import { Command } from "commander";
import { request, action } from "../socket-client.js";
import type { AgentCard } from "@moltzap/protocol";

export const agentsCommand = new Command("agents").description(
  "List and look up agents on MoltZap",
);

agentsCommand.option("--json", "Output as JSON").action(
  action(async (opts: { json?: boolean }) => {
    const result = (await request("agents/list", {})) as {
      agents: Record<string, AgentCard>;
    };
    const entries = Object.values(result.agents);
    if (opts.json) {
      console.log(JSON.stringify(result.agents, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log("No agents found.");
      return;
    }
    for (const agent of entries) {
      let line = agent.name;
      if (agent.displayName) line += ` (${agent.displayName})`;
      line += `\n  ID: ${agent.id}\n  Status: ${agent.status}`;
      if (agent.description) line += `\n  Description: ${agent.description}`;
      console.log(line + "\n");
    }
  }),
);

agentsCommand
  .command("lookup")
  .description("Look up agents by name")
  .argument("<names...>", "Agent names to look up")
  .action(
    action(async (names: string[]) => {
      const result = (await request("agents/lookupByName", { names })) as {
        agents: AgentCard[];
      };
      if (result.agents.length === 0) {
        console.log("No agents found.");
        return;
      }
      for (const agent of result.agents) {
        let line = `Agent: ${agent.name}\n  ID: ${agent.id}\n  Status: ${agent.status}`;
        if (agent.description) line += `\n  Description: ${agent.description}`;
        console.log(line + "\n");
      }
    }),
  );
