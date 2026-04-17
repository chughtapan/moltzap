import { describe, expect, beforeAll, afterAll } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { MoltZapTestClient } from "./helpers.js";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../test-utils/index.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const { inject } = await import("vitest");
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  const server = await startCoreTestServer({ pgHost, pgPort });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopCoreTestServer();
});

describe("Registration secret enforcement", () => {
  it.live("allows registration when no secret is configured (default)", () =>
    Effect.gen(function* () {
      const client = new MoltZapTestClient(baseUrl, wsUrl);
      const result = yield* client.register("open-agent");
      expect(result.agentId).toBeDefined();
      expect(result.apiKey).toBeDefined();
      yield* client.close();
    }),
  );

  it.live("returns agent data on successful registration", () =>
    Effect.gen(function* () {
      const client = new MoltZapTestClient(baseUrl, wsUrl);
      const result = yield* client.register("test-agent-data");
      expect(typeof result.agentId).toBe("string");
      expect(typeof result.apiKey).toBe("string");
      expect(result.agentId.length).toBeGreaterThan(0);
      yield* client.close();
    }),
  );
});
