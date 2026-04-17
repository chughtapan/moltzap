import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import { MoltZapWsClient } from "@moltzap/client";
import { registerAgent, stripWsPath } from "@moltzap/client/test";

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
      const client = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: reg.apiKey,
      });
      const result = yield* Effect.exit(client.connect());
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
