import { Command } from "commander";
import { getHttpUrl } from "../client/config.js";

export const pingCommand = new Command("ping")
  .description("Check if the MoltZap server is reachable")
  .action(async () => {
    const url = `${getHttpUrl()}/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log("Server reachable");
        process.exit(0);
      } else {
        console.error(`Server unreachable: HTTP ${res.status}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `Server unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
