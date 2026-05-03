import * as net from "node:net";
import * as fs from "node:fs";
import { Data, Effect } from "effect";
import { MoltZapService } from "../service.js";

import { AgentsLookupByName } from "@moltzap/protocol";

const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

interface RawResponse {
  result?: unknown;
  error?: string;
}

export class SocketRequestError extends Data.TaggedError("SocketRequestError")<{
  readonly method: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ParticipantResolveError extends Data.TaggedError(
  "ParticipantResolveError",
)<{
  readonly input: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SocketClientError = SocketRequestError | ParticipantResolveError;

const socketRequestError = (
  method: string,
  message: string,
  cause?: unknown,
): SocketRequestError => new SocketRequestError({ method, message, cause });

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
): Effect.Effect<unknown, SocketRequestError> =>
  Effect.async<unknown, SocketRequestError>((resume, signal) => {
    const sockPath = socketPath ?? MoltZapService.SOCKET_PATH;
    const conn = net.createConnection(sockPath);
    let buffer = "";
    let settled = false;

    const done = (outcome: Effect.Effect<unknown, SocketRequestError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.removeAllListeners();
      conn.destroy();
      resume(outcome);
    };

    const timer = setTimeout(() => {
      done(Effect.fail(socketRequestError(method, "Socket request timed out")));
    }, SOCKET_REQUEST_TIMEOUT_MS);

    signal.addEventListener("abort", () => {
      done(Effect.fail(socketRequestError(method, "Socket request aborted")));
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
              socketRequestError(
                method,
                `Malformed response from service: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                err,
              ),
            ),
          );
          return;
        }
        if (parsed.error) {
          done(Effect.fail(socketRequestError(method, parsed.error)));
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
            socketRequestError(
              method,
              "MoltZap service is not running. Start the OpenClaw channel plugin first.",
              err,
            ),
          ),
        );
      } else {
        done(Effect.fail(socketRequestError(method, err.message, err)));
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
): Effect.Effect<{ type: string; id: string }, SocketClientError> =>
  Effect.gen(function* () {
    const colon = raw.indexOf(":");
    if (colon === -1) {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Invalid: "${raw}". Use agent:name`,
        }),
      );
    }
    const type = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    if (UUID_RE.test(value)) return { type, id: value };
    if (type !== "agent") {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Cannot resolve "${raw}"`,
        }),
      );
    }
    const result = (yield* request(AgentsLookupByName.name, {
      names: [value],
    })) as LookupResult;
    if (result.agents.length === 0) {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Agent "${value}" not found`,
        }),
      );
    }
    return { type: "agent", id: result.agents[0]!.id };
  });

/** Pure predicate: socket path exists. Wrapped in Effect so callers compose it. */
export const isServiceRunning: Effect.Effect<boolean> = Effect.sync(() =>
  fs.existsSync(MoltZapService.SOCKET_PATH),
);
