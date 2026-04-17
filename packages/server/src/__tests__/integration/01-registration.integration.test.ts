import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
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

describe("Scenario 1: Registration", () => {
  it.live("registers an agent and returns API key", () =>
    Effect.gen(function* () {
      const client = new MoltZapTestClient(baseUrl, wsUrl);
      const reg = yield* client.register("test-agent");

      expect(reg.agentId).toBeDefined();
      expect(reg.apiKey).toMatch(/^moltzap_agent_/);

      yield* client.close();
    }),
  );

  it.live("rejects duplicate agent names", () =>
    Effect.gen(function* () {
      const client = new MoltZapTestClient(baseUrl, wsUrl);
      yield* client.register("unique-agent");

      const result = yield* Effect.exit(client.register("unique-agent"));
      expect(result._tag).toBe("Failure");

      yield* client.close();
    }),
  );

  it.live(
    "registered agent is active immediately and can use all methods",
    () =>
      Effect.gen(function* () {
        const client = new MoltZapTestClient(baseUrl, wsUrl);
        const reg = yield* client.register("active-agent");

        const hello = (yield* client.connect(reg.apiKey)) as Record<
          string,
          unknown
        >;
        expect(hello.protocolVersion).toBeDefined();
        expect(hello.agentId).toBe(reg.agentId);

        const result = (yield* client.rpc("conversations/list", {})) as {
          conversations: unknown[];
        };
        expect(result.conversations).toEqual([]);

        yield* client.close();
      }),
  );

  it.live("suspended agent cannot connect", () =>
    Effect.gen(function* () {
      const client = new MoltZapTestClient(baseUrl, wsUrl);
      const reg = yield* client.register("suspended-agent");

      const db = getCoreDb();
      yield* Effect.tryPromise(() =>
        db
          .updateTable("agents")
          .set({ status: "suspended" })
          .where("id", "=", reg.agentId)
          .execute(),
      );

      const result = yield* Effect.exit(client.connect(reg.apiKey));
      expect(result._tag).toBe("Failure");

      yield* client.close();
    }),
  );
});
