import * as net from "node:net";
import * as fs from "node:fs";
import { Effect } from "effect";
import { MoltZapService } from "../service.js";

interface RawResponse {
  result?: unknown;
  error?: string;
}

/**
 * Send a request to the MoltZapService via Unix socket, returning the `result`
 * field as an Effect. Typed failures:
 *   - "service not running" when the socket path doesn't exist / ECONNREFUSED
 *   - "timeout" when the 10s deadline elapses
 *   - "remote error" when the server responds with `{error: "..."}`
 *   - "malformed" when the response isn't parseable JSON
 *
 * Uses `Effect.async` so fiber interruption cleanly destroys the socket
 * (AbortSignal callback) — no leaked fd if a parent fiber times out.
 */
export const request = (
  method: string,
  params?: Record<string, unknown>,
  socketPath?: string,
): Effect.Effect<unknown, Error> =>
  Effect.async<unknown, Error>((resume, signal) => {
    const sockPath = socketPath ?? MoltZapService.SOCKET_PATH;
    const conn = net.createConnection(sockPath);
    let buffer = "";
    let settled = false;

    const done = (outcome: Effect.Effect<unknown, Error>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.removeAllListeners();
      conn.destroy();
      resume(outcome);
    };

    const timer = setTimeout(() => {
      done(Effect.fail(new Error("Socket request timed out")));
    }, 10_000);

    signal.addEventListener("abort", () => {
      done(Effect.fail(new Error("Socket request aborted")));
    });

    conn.on("connect", () => {
      conn.write(JSON.stringify({ method, params }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        conn.end();
        let parsed: RawResponse;
        try {
          parsed = JSON.parse(line) as RawResponse;
        } catch (err) {
          done(
            Effect.fail(
              new Error(
                `Malformed response from service: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            ),
          );
          return;
        }
        if (parsed.error) {
          done(Effect.fail(new Error(parsed.error)));
        } else {
          done(Effect.succeed(parsed.result));
        }
      }
    });

    conn.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        done(
          Effect.fail(
            new Error(
              "MoltZap service is not running. Start the OpenClaw channel plugin first.",
            ),
          ),
        );
      } else {
        done(Effect.fail(err));
      }
    });
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LookupResult {
  agents: Array<{ id: string }>;
}

/** Resolve "agent:name" or "agent:<uuid>" to { type, id }. */
export const resolveParticipant = (
  raw: string,
): Effect.Effect<{ type: string; id: string }, Error> =>
  Effect.gen(function* () {
    const colon = raw.indexOf(":");
    if (colon === -1) {
      return yield* Effect.fail(new Error(`Invalid: "${raw}". Use agent:name`));
    }
    const type = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    if (UUID_RE.test(value)) return { type, id: value };
    if (type !== "agent") {
      return yield* Effect.fail(new Error(`Cannot resolve "${raw}"`));
    }
    const result = (yield* request("agents/lookupByName", {
      names: [value],
    })) as LookupResult;
    if (result.agents.length === 0) {
      return yield* Effect.fail(new Error(`Agent "${value}" not found`));
    }
    return { type: "agent", id: result.agents[0]!.id };
  });

/** Pure predicate: socket path exists. Wrapped in Effect so callers compose it. */
export const isServiceRunning: Effect.Effect<boolean> = Effect.sync(() =>
  fs.existsSync(MoltZapService.SOCKET_PATH),
);
