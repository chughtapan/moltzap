import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";
import type { AgentCard } from "@moltzap/protocol";
import { request } from "../socket-client.js";

interface AgentsListResult {
  agents: Record<string, AgentCard>;
}

interface LookupResult {
  agents: AgentCard[];
}

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);

const listAgents = Command.make("list", { json: jsonOption }, ({ json }) =>
  request("agents/list", {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const r = result as AgentsListResult;
        const entries = Object.values(r.agents);
        if (json) {
          console.log(JSON.stringify(r.agents, null, 2));
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
          if (agent.description)
            line += `\n  Description: ${agent.description}`;
          console.log(line + "\n");
        }
      }),
    ),
    Effect.asVoid,
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }),
    ),
  ),
).pipe(Command.withDescription("List agents (default)"));

const namesArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Agent names to look up"),
  Args.repeated,
);

const lookupAgents = Command.make("lookup", { names: namesArg }, ({ names }) =>
  request("agents/lookupByName", { names }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const r = result as LookupResult;
        if (r.agents.length === 0) {
          console.log("No agents found.");
          return;
        }
        for (const agent of r.agents) {
          let line = `Agent: ${agent.name}\n  ID: ${agent.id}\n  Status: ${agent.status}`;
          if (agent.description)
            line += `\n  Description: ${agent.description}`;
          console.log(line + "\n");
        }
      }),
    ),
    Effect.asVoid,
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }),
    ),
  ),
).pipe(Command.withDescription("Look up agents by name"));

/**
 * `moltzap agents [list|lookup]` — default (no subcommand) lists all agents,
 * `lookup` resolves one or more names. `--json` flag on `list` dumps the raw
 * shape for scripting.
 */
export const agentsCommand = Command.make("agents", {}, () =>
  // Bare `moltzap agents` with no subcommand defaults to listing.
  listAgents.handler({ json: false }),
).pipe(
  Command.withDescription("List and look up agents on MoltZap"),
  Command.withSubcommands([listAgents, lookupAgents]),
);
