import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";

export const presenceCommand = new Command("presence")
  .description("Update or show presence status (online, offline, away)")
  .argument("[status]", "Status to set: online, offline, or away")
  .action(async (status?: string) => {
    const auth = resolveAuth();
    const client = new WsClient();
    try {
      await client.connect(auth);

      if (!status) {
        console.log("Presence: connected (online)");
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

      await client.rpc("presence/update", { status });
      console.log(`Presence set to ${status}.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });
