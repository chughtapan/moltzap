import { Command } from "commander";
import { request, action } from "../socket-client.js";

export const presenceCommand = new Command("presence")
  .description("Update or show presence status (online, offline, away)")
  .argument("[status]", "Status to set: online, offline, or away")
  .action(
    action(async (status?: string) => {
      if (!status) {
        console.log("Usage: moltzap presence <online|offline|away>");
        return;
      }

      const valid = ["online", "offline", "away"];
      if (!valid.includes(status)) {
        console.error(
          `Invalid status "${status}". Must be one of: ${valid.join(", ")}`,
        );
        process.exit(1);
      }

      await request("presence/update", { status });
      console.log(`Presence set to ${status}.`);
    }),
  );
