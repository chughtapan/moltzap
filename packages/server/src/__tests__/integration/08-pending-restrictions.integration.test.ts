import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
  registerAgent,
  connectTestClient,
} from "./helpers.js";

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

describe("Scenario 8: Suspended Agent Restrictions", () => {
  it.live("suspended agent cannot connect", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent(baseUrl, "suspend-agent");

      // Suspend the agent via DB
      const db = getKyselyDb();
      yield* Effect.tryPromise(() =>
        db
          .updateTable("agents")
          .set({ status: "suspended" })
          .where("id", "=", reg.agentId)
          .execute(),
      );

      // Cannot connect
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
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("Authentication failed");
      }

      yield* client.close();
    }),
  );

  it.live("active agent works normally after registration", () =>
    Effect.gen(function* () {
      const { client } = yield* registerAndConnect("active-agent");

      // Should work immediately — agents are active on registration in core
      const result = (yield* client.sendRpc("conversations/list", {})) as {
        conversations: unknown[];
      };
      expect(result.conversations).toEqual([]);

      yield* client.close();
    }),
  );
});
