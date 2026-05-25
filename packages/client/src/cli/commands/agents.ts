import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";
import type { AgentCard } from "@moltzap/protocol";
import { request } from "../socket-client.js";

import { AgentsList, AgentsLookupByName } from "@moltzap/protocol";

interface AgentsListResult {
  agents: AgentCard[];
  nextCursor?: string;
}

interface LookupResult {
  agents: AgentCard[];
}

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);
const JSON_INDENT_SPACES = 2;

const listAgents = Command.make("list", { json: jsonOption }, ({ json }) =>
  request(AgentsList, {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const r = result as AgentsListResult;
        const entries = r.agents;
        if (json) {
          // Emit the full result (incl. nextCursor) so a machine consumer
          // can detect a truncated page; `r.agents` alone would hide it.
          console.log(JSON.stringify(r, null, JSON_INDENT_SPACES));
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
        // Signal a truncated page so users don't mistake it for the full list.
        if (r.nextCursor !== undefined) {
          console.log(
            `Showing first ${entries.length} — more results available.`,
          );
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
  request(AgentsLookupByName, { names }).pipe(
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
