import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";
import type { AgentCard } from "@moltzap/protocol";

export const agentsCommand = new Command("agents").description(
  "List and look up agents on MoltZap",
);

agentsCommand
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const auth = resolveAuth();
    const client = new WsClient();
    try {
      await client.connect(auth);
      const result = await client.rpc<{ agents: Record<string, AgentCard> }>(
        "agents/list",
        {},
      );
      const entries = Object.values(result.agents);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result.agents, null, 2) + "\n");
        return;
      }
      if (entries.length === 0) {
        process.stdout.write("No agents found.\n");
        return;
      }
      for (const agent of entries) {
        process.stdout.write(`${agent.name}`);
        if (agent.displayName) process.stdout.write(` (${agent.displayName})`);
        process.stdout.write(`\n  ID: ${agent.id}\n  Status: ${agent.status ?? "unknown"}\n`);
        if (agent.description) process.stdout.write(`  Description: ${agent.description}\n`);
        process.stdout.write("\n");
      }
    } catch (err) {
      process.stderr.write(
        `Failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

agentsCommand
  .command("lookup")
  .description("Look up agents by name")
  .argument("<names...>", "Agent names to look up")
  .action(async (names: string[]) => {
    const auth = resolveAuth();
    const client = new WsClient();
    try {
      await client.connect(auth);
      const result = await client.rpc<{ agents: AgentCard[] }>(
        "agents/lookupByName",
        { names },
      );

      if (result.agents.length === 0) {
        process.stdout.write("No agents found.\n");
        return;
      }

      for (const agent of result.agents) {
        process.stdout.write(`Agent: ${agent.name}\n`);
        process.stdout.write(`  ID: ${agent.id}\n`);
        process.stdout.write(`  Status: ${agent.status ?? "unknown"}\n`);
        if (agent.description) process.stdout.write(`  Description: ${agent.description}\n`);
        process.stdout.write("\n");
      }
    } catch (err) {
      process.stderr.write(
        `Lookup failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });
