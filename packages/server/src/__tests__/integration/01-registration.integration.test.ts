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

describe("Scenario 1: Registration", () => {
  it.live("registers an agent and returns API key", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent(baseUrl, "test-agent");

      expect(reg.agentId).toBeDefined();
      expect(reg.apiKey).toMatch(/^moltzap_agent_/);
    }),
  );

  it.live("rejects duplicate agent names", () =>
    Effect.gen(function* () {
      yield* registerAgent(baseUrl, "unique-agent");

      const result = yield* Effect.exit(registerAgent(baseUrl, "unique-agent"));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.live(
    "registered agent is active immediately and can use all methods",
    () =>
      Effect.gen(function* () {
        const reg = yield* registerAgent(baseUrl, "active-agent");
        const client = yield* connectTestClient({
          wsUrl,
          agentId: reg.agentId,
          apiKey: reg.apiKey,
          autoConnect: false,
        });

        const hello = (yield* client.sendRpc("auth/connect", {
          agentKey: reg.apiKey,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        })) as Record<string, unknown>;
        expect(hello.protocolVersion).toBeDefined();
        expect(hello.agentId).toBe(reg.agentId);

        const result = (yield* client.sendRpc("conversations/list", {})) as {
          conversations: unknown[];
        };
        expect(result.conversations).toEqual([]);

        yield* client.close();
      }),
  );

  it.live("suspended agent cannot connect", () =>
    Effect.gen(function* () {
      const reg = yield* registerAgent(baseUrl, "suspended-agent");

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
