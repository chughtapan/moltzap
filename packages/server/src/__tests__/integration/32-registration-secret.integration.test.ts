import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  it("allows registration when no secret is configured (default)", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const result = await client.register("open-agent");
    expect(result.agentId).toBeDefined();
    expect(result.apiKey).toBeDefined();
    client.close();
  });

  it("returns agent data on successful registration", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const result = await client.register("test-agent-data");
    expect(typeof result.agentId).toBe("string");
    expect(typeof result.apiKey).toBe("string");
    expect(result.agentId.length).toBeGreaterThan(0);
    client.close();
  });
});
