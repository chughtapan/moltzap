import { Command } from "commander";
import { MoltZapService } from "../../service.js";
import { resolveAuth, getServerUrl } from "../config.js";

export const listenCommand = new Command("listen")
  .description("Listen for real-time events via WebSocket (JSON output)")
  .action(async () => {
    const service = new MoltZapService({
      serverUrl: getServerUrl(),
      agentKey: resolveAuth().agentKey,
    });

    process.on("SIGINT", () => {
      service.close();
      process.exit(0);
    });

    try {
      await service.connect();

      service.on("rawEvent", (event) => {
        console.log(JSON.stringify(event));
      });

      // Keep the process running — MoltZapService auto-reconnects
      await new Promise(() => {});
    } catch (err) {
      console.error(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
