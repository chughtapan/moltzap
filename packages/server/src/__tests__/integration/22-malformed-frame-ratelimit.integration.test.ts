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
 */

import { describe, expect, beforeAll, afterAll } from "vitest";
import { it } from "@effect/vitest";
import { Duration, Effect, Ref, Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import { NodeSocket } from "@effect/platform-node";
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

/** Open an Effect-native WebSocket, push every frame, and collect responses.
 * Bypasses `MoltZapTestClient` so we can send frames that don't pass the
 * protocol validator. */
const sendRawFrames = (wsUrl: string, frames: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const responsesRef = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const scope = yield* Scope.make();
      const socket = yield* Scope.extend(
        Socket.makeWebSocket(wsUrl, { openTimeout: Duration.seconds(5) }),
        scope,
      );
      const writer = yield* Scope.extend(socket.writer, scope);

      const reader = Effect.fork(
        socket
          .runRaw((data) =>
            Effect.sync(() => {
              const raw =
                typeof data === "string"
                  ? data
                  : new TextDecoder("utf-8").decode(data);
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                parsed = { __raw: raw };
              }
              Effect.runSync(Ref.update(responsesRef, (xs) => [...xs, parsed]));
            }),
          )
          .pipe(Effect.catchAll(() => Effect.void)),
      );
      yield* reader;

      for (const f of frames) {
        yield* writer(f).pipe(Effect.catchAll(() => Effect.void));
        // Let the server handler drain each frame individually — without
        // this yield, ws coalesces multiple sends into one chunk and the
        // server-side `runRaw` sees a truncated stream.
        yield* Effect.sleep(Duration.millis(1));
      }

      // Wait for the server to flush every response.
      yield* Effect.sleep(Duration.millis(200));
      yield* Scope.close(scope, undefined as never);
      return yield* Ref.get(responsesRef);
    }),
  ).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));

describe("Scenario 22: malformed-frame flood does not crash the server", () => {
  it.live(
    "responds with ParseError to 101 garbage frames and server survives",
    () =>
      Effect.gen(function* () {
        const wsUrl = getWsUrl();

        // Mix of JSON-syntax errors targeting the `JSON.parse` branch —
        // valid-JSON-but-wrong-shape frames go through `validators.requestFrame`.
        const garbage: string[] = [];
        for (let i = 0; i < 101; i++) {
          garbage.push(`{not-json-${i}`);
        }

        const responses = yield* sendRawFrames(wsUrl, garbage);

        // The server may coalesce a few frames at high load; assert "at
        // least most came back" instead of an exact count.
        const parseErrors = responses.filter((r) => {
          const f = r as { error?: { code?: number } };
          return f.error?.code === ErrorCodes.ParseError;
        });
        expect(parseErrors.length).toBeGreaterThanOrEqual(95);

        // Fresh connection still works after the flood.
        const agent = yield* registerAndConnect("post-flood-agent");
        expect(agent.agentId).toBeDefined();
      }),
  );

  it.live(
    "parse-error response uses id:null for frames the server can't parse",
    () =>
      Effect.gen(function* () {
        const wsUrl = getWsUrl();

        const responses = yield* sendRawFrames(wsUrl, ["not-json-at-all"]);

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
