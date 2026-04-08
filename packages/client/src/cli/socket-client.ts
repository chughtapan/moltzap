import * as net from "node:net";
import * as fs from "node:fs";
import { MoltZapService } from "../service.js";

/**
 * Send a request to the MoltZapService via Unix socket and return the result.
 * Throws if the service is not running or the request fails.
 */
export async function request(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(MoltZapService.SOCKET_PATH);
    let buffer = "";

    conn.on("connect", () => {
      conn.write(JSON.stringify({ method, params }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        conn.end();
        const response = JSON.parse(line) as {
          result?: unknown;
          error?: string;
        };
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.result);
        }
      }
    });

    conn.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "MoltZap service is not running. Start the OpenClaw channel plugin first.",
          ),
        );
      } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        reject(
          new Error(
            "MoltZap service is not running. Start the OpenClaw channel plugin first.",
          ),
        );
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      conn.destroy();
      reject(new Error("Socket request timed out"));
    }, 10_000);
  });
}

export function isServiceRunning(): boolean {
  return fs.existsSync(MoltZapService.SOCKET_PATH);
}
