import { Command } from "@effect/cli";
import { Effect } from "effect";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import { logLines } from "../output.js";

// safer-arch-ignore no-trivial-sink-file: this command is a private one-command-per-file leaf consistent with the CLI commands folder convention.

/**
 * `moltzap status` — calls the local service's `status` RPC and prints
 * agent id, live connection state, and conversation count.
 */
export const statusCommand = Command.make("status", {}, () =>
  runHandler(
    command(LocalDaemonCommands.status, {}).pipe(
      Effect.flatMap((result) =>
        logLines([
          `Agent ID:       ${result.agentId ?? "none"}`,
          `Connected:      ${result.connected}`,
          `Conversations:  ${result.conversations}`,
        ]),
      ),
      Effect.asVoid,
    ),
  ),
).pipe(
  Command.withDescription(
    "Show agent connection status and conversation summary",
  ),
);
