import { Args, Command } from "@effect/cli";
import { Effect } from "effect";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import { logJson, logLines } from "../output.js";

// safer-arch-ignore folder-explicit-api-required: the CLI entrypoint deliberately composes private one-command-per-file leaves; this folder is not a reusable API.
// safer-arch-ignore no-trivial-sink-file: this command is a private one-command-per-file leaf consistent with the CLI commands folder convention.
const listAgents = Command.make("list", {}, () =>
  runHandler(
    command(LocalDaemonCommands.agentsList, {}).pipe(
      Effect.flatMap(logJson),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("List agents (default)"));

const namesArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Agent names to look up"),
  Args.repeated,
);

const lookupAgents = Command.make("lookup", { names: namesArg }, ({ names }) =>
  runHandler(
    command(LocalDaemonCommands.agentsSearch, { names }).pipe(
      Effect.flatMap((result) => {
        if (result.agents.length === 0) {
          return Effect.log("No agents found.");
        }
        return logLines(
          result.agents.map((agent) => {
            let line = `Agent: ${agent.name}\n  ID: ${agent.id}\n  Status: ${agent.status}`;
            if (agent.description) {
              line += `\n  Description: ${agent.description}`;
            }
            return `${line}\n`;
          }),
        );
      }),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("Look up agents by name"));

/**
 * `moltzap agents [list|lookup]` — default (no subcommand) lists all agents,
 * `lookup` resolves one or more names.
 */
export const agentsCommand = Command.make("agents", {}, () =>
  listAgents.handler({}),
).pipe(
  Command.withDescription("List and look up agents on MoltZap"),
  Command.withSubcommands([listAgents, lookupAgents]),
);
