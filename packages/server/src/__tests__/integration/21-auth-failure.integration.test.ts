import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import {
  connectTestClient,
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAgent,
} from "./helpers.js";
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
      const client = yield* connectTestClient({
        wsUrl,
        agentId: "unknown-agent",
        apiKey: "invalid_key_12345",
        autoConnect: false,
      });

      const result = yield* Effect.exit(
        client.sendRpc("auth/connect", {
          agentKey: "invalid_key_12345",
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("Authentication failed");
      }

      yield* client.close();
    }),
  );

  it.live("unauthenticated RPC call is rejected", () =>
    Effect.gen(function* () {
      const client = yield* connectTestClient({
        wsUrl,
        agentId: "unknown-agent",
        apiKey: "mz_totally_fake_api_key_000000000000",
        autoConnect: false,
      });

      const result = yield* Effect.exit(
        client.sendRpc("auth/connect", {
          agentKey: "mz_totally_fake_api_key_000000000000",
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        }),
      );
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

      const client = yield* connectTestClient({
        wsUrl,
        agentId: reg.agentId,
        apiKey: reg.apiKey,
        autoConnect: false,
      });
      const result = yield* Effect.exit(
        client.sendRpc("auth/connect", {
          agentKey: reg.apiKey,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        }),
      );
      expect(result._tag).toBe("Failure");

      yield* client.close();
    }),
  );
});
