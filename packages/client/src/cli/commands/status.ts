import { Command } from "@effect/cli";
import { Effect } from "effect";
import { LocalServiceCommands, requestLocalService } from "../socket-client.js";

/**
 * `moltzap status` — calls the local service's `status` RPC and prints
 * agent id, live connection state, and conversation count.
 */
export const statusCommand = Command.make("status", {}, () =>
  requestLocalService(LocalServiceCommands.Status).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        console.log(`Agent ID:       ${result.agentId ?? "none"}`);
        console.log(`Connected:      ${result.connected}`);
        console.log(`Conversations:  ${result.conversations}`);
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
).pipe(
  Command.withDescription(
    "Show agent connection status and conversation summary",
  ),
);
