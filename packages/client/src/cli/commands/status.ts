import { Command } from "@effect/cli";
import { Effect } from "effect";
import { request } from "../socket-client.js";

interface StatusResult {
  agentId: string;
  connected: boolean;
  conversations: number;
}

/**
 * `moltzap status` — calls the local service's `status` RPC and prints
 * agent id, live connection state, and conversation count.
 */
export const statusCommand = Command.make("status", {}, () =>
  request("status").pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const r = result as StatusResult;
        console.log(`Agent ID:       ${r.agentId ?? "none"}`);
        console.log(`Connected:      ${r.connected}`);
        console.log(`Conversations:  ${r.conversations}`);
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
