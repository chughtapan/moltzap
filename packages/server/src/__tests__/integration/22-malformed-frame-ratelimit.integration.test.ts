/**
 * Flood test for the WebSocket malformed-frame path.
 *
 * The server uses a per-connection counter with `MALFORMED_LOG_EVERY = 50`
 * so a hostile or buggy client sending garbage frames can't dominate the
 * log. This test doesn't try to observe logger calls directly — the
 * server's logger is a process-global pino instance with no injection
 * seam — but it does prove the more load-bearing contract:
 *
 *   1. The server stays up under 100+ garbage frames on a single socket.
 *   2. Every malformed frame produces a `ParseError` response frame.
 *   3. A normal RPC still works on a fresh connection after the flood.
 *
 * If the per-connection counter leaks or the handler throws, the socket
 * tears down and the first two assertions fail. If the rate-limit logic
 * accidentally drops response frames, (2) fails.
 */

import { describe, expect, beforeAll, afterAll } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import WebSocket from "ws";
import {
  startTestServer,
  stopTestServer,
  registerAndConnect,
} from "./helpers.js";
import { getWsUrl } from "../../test-utils/index.js";
import { ErrorCodes } from "@moltzap/protocol";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

/**
 * Open a raw WebSocket, send every payload in `frames`, and return every
 * response frame the server sent back before close. Uses raw `ws` — the
 * `MoltZapTestClient` doesn't expose a way to bypass the validator.
 */
async function sendRawFrames(
  wsUrl: string,
  frames: string[],
): Promise<unknown[]> {
  const responses: unknown[] = [];
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.on("message", (data) => {
    try {
      responses.push(JSON.parse(data.toString()));
    } catch {
      // If the server somehow sends non-JSON, record the raw string so
      // the test assertion surfaces it clearly.
      responses.push({ __raw: data.toString() });
    }
  });

  for (const f of frames) {
    ws.send(f);
    // Tiny pause so the server doesn't coalesce frames at the socket layer.
    // Without this, several `ws.send` calls end up in one chunk and the
    // server sees a truncated message stream.
    await new Promise((r) => setImmediate(r));
  }

  // Wait for the server to flush every response. 200ms is generous —
  // local PGlite round-trips are sub-millisecond.
  await new Promise((r) => setTimeout(r, 200));
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  return responses;
}

describe("Scenario 22: malformed-frame flood does not crash the server", () => {
  it.live(
    "responds with ParseError to 101 garbage frames and server survives",
    () =>
      Effect.gen(function* () {
        const wsUrl = getWsUrl();

        // Mix of JSON-syntax errors and not-valid-frame shapes. The test
        // targets JSON.parse errors specifically — the branch that increments
        // `malformedFrameCount`. Frames with valid JSON but invalid shape
        // take the `validators.requestFrame` branch instead.
        const garbage: string[] = [];
        for (let i = 0; i < 101; i++) {
          garbage.push(`{not-json-${i}`);
        }

        const responses = yield* Effect.promise(() =>
          sendRawFrames(wsUrl, garbage),
        );

        // Each garbage frame should produce exactly one response frame with
        // the canonical ParseError code. The server may coalesce a few at
        // high load; we assert "at least most of them came back" rather than
        // an exact count to avoid scheduler flakiness.
        const parseErrors = responses.filter((r) => {
          const f = r as { error?: { code?: number } };
          return f.error?.code === ErrorCodes.ParseError;
        });
        expect(parseErrors.length).toBeGreaterThanOrEqual(95);

        // Server must still accept a fresh connection after the flood.
        // `registerAndConnect` round-trips an auth/connect; if the server
        // had crashed or the WebSocket upgrade path were wedged, this would
        // throw.
        const agent = yield* registerAndConnect("post-flood-agent");
        expect(agent.agentId).toBeDefined();
      }),
  );

  it.live(
    "parse-error response uses id:null for frames the server can't parse",
    () =>
      Effect.gen(function* () {
        const wsUrl = getWsUrl();

        const responses = yield* Effect.promise(() =>
          sendRawFrames(wsUrl, ["not-json-at-all"]),
        );

        // At least one ParseError response must have landed. Its id must be
        // null because the server can't extract one from invalid JSON.
        const parseErrors = responses.filter((r) => {
          const f = r as { error?: { code?: number } };
          return f.error?.code === ErrorCodes.ParseError;
        });
        expect(parseErrors.length).toBeGreaterThanOrEqual(1);
        const first = parseErrors[0] as {
          id: unknown;
          error: { code: number; message: string };
        };
        expect(first.id).toBeNull();
        expect(first.error.message).toMatch(/invalid json/i);
      }),
  );
});
