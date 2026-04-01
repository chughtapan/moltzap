import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";
import type { EventFrame } from "@moltzap/protocol";

export const listenCommand = new Command("listen")
  .description("Listen for real-time events via WebSocket (JSON output)")
  .action(async () => {
    const auth = resolveAuth();
    const client = new WsClient({ autoReconnect: true });

    // Graceful shutdown on SIGINT
    process.on("SIGINT", () => {
      client.close();
      process.exit(0);
    });

    try {
      await client.connect(auth);

      client.onEvent((event: EventFrame) => {
        console.log(JSON.stringify(event));
      });

      // Keep the process running
      await new Promise(() => {
        // Intentionally never resolves — waits for Ctrl+C
      });
    } catch (err) {
      console.error(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
