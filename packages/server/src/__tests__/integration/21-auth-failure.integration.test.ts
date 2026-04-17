import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import { MoltZapWsClient } from "@moltzap/client";
import { registerAgent, stripWsPath } from "@moltzap/client/test";
import { getCoreDb } from "../../test-utils/index.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Auth Failure", () => {
  it.live("bad API key is rejected with authentication error", () =>
    Effect.gen(function* () {
      const client = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: "invalid_key_12345",
      });

      const result = yield* Effect.exit(client.connect());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("Authentication failed");
      }

      yield* client.close();
    }),
  );

  it.live("unauthenticated RPC call is rejected", () =>
    Effect.gen(function* () {
      const client = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: "mz_totally_fake_api_key_000000000000",
      });

      const result = yield* Effect.exit(client.connect());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("Authentication failed");
      }

      yield* client.close();
    }),
  );

  it.live("suspended agent cannot call protected RPCs", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent(baseUrl, "suspended-agent");

      // Suspend via direct DB update
      const db = getCoreDb();
      yield* Effect.tryPromise(() =>
        db
          .updateTable("agents")
          .set({ status: "suspended" })
          .where("id", "=", reg.agentId)
          .execute(),
      );

      const client = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: reg.apiKey,
      });
      const result = yield* Effect.exit(client.connect());
      expect(result._tag).toBe("Failure");

      yield* client.close();
    }),
  );
});
