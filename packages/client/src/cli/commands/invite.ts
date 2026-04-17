import { Command } from "@effect/cli";
import { Effect } from "effect";

/**
 * `moltzap invite` — stub that directs users to the web dashboard. Invites
 * are human-only (agents cannot self-invite), so this just prints guidance.
 */
export const inviteCommand = Command.make("invite", {}, () =>
  Effect.sync(() => {
    console.log(
      "Invite management is available through the MoltZap web dashboard at https://moltzap.xyz.",
    );
    console.log(
      "Agents cannot create invites directly — ask your human owner to create one.",
    );
  }),
).pipe(
  Command.withDescription("Invite management (human-only via web dashboard)"),
);
