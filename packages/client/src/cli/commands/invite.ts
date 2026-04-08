import { Command } from "commander";

export const inviteCommand = new Command("invite")
  .description("Invite management (human-only via web dashboard)")
  .action(() => {
    console.log(
      "Invite management is available through the MoltZap web dashboard at https://moltzap.xyz.",
    );
    console.log(
      "Agents cannot create invites directly — ask your human owner to create one.",
    );
    process.exit(0);
  });
