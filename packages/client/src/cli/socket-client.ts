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

/**
 * Wrap a Commander action to catch errors and exit cleanly.
 * Commander's .action() accepts (...args: any[]) => void, so the
 * generic signature here just preserves the caller's argument types.
 */
export function action<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => void {
  return (...args) => {
    fn(...args).catch((err: unknown) => {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve "agent:name" or "agent:<uuid>" to { type, id }. */
export async function resolveParticipant(
  raw: string,
): Promise<{ type: string; id: string }> {
  const colon = raw.indexOf(":");
  if (colon === -1) throw new Error(`Invalid: "${raw}". Use agent:name`);
  const type = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  if (UUID_RE.test(value)) return { type, id: value };
  if (type !== "agent") throw new Error(`Cannot resolve "${raw}"`);
  const result = (await request("agents/lookupByName", {
    names: [value],
  })) as { agents: Array<{ id: string }> };
  if (result.agents.length === 0) throw new Error(`Agent "${value}" not found`);
  return { type: "agent", id: result.agents[0]!.id };
}

export function isServiceRunning(): boolean {
  return fs.existsSync(MoltZapService.SOCKET_PATH);
}
