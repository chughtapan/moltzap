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
  socketPath?: string,
): Promise<unknown> {
  const sockPath = socketPath ?? MoltZapService.SOCKET_PATH;
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new Error("Socket request timed out"));
    }, 10_000);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ method, params }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        conn.end();
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          const response = JSON.parse(line) as {
            result?: unknown;
            error?: string;
          };
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.result);
          }
        } catch {
          reject(new Error("Malformed response from service"));
        }
      }
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        reject(
          new Error(
            "MoltZap service is not running. Start the OpenClaw channel plugin first.",
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

export function isServiceRunning(): boolean {
  return fs.existsSync(MoltZapService.SOCKET_PATH);
}
