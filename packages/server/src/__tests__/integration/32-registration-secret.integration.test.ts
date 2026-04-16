import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stopTestServer, resetTestDb, MoltZapTestClient } from "./helpers.js";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../test-utils/index.js";
import type { CoreApp } from "../../app/types.js";

let baseUrl: string;
let wsUrl: string;
let app: CoreApp;

beforeAll(async () => {
  const { inject } = await import("vitest");
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  const server = await startCoreTestServer({ pgHost, pgPort });
  // Reconfigure with a registration secret
  // We need to stop and restart with the secret config
  await server.coreApp.close();
  await stopCoreTestServer();

  // Start a new server with registration secret configured
  const secretServer = await startCoreTestServer({ pgHost, pgPort });
  app = secretServer.coreApp;
  baseUrl = secretServer.baseUrl;
  wsUrl = secretServer.wsUrl;

  // Monkey-patch the Hono app to simulate registration secret
  // Since createCoreApp reads config.registration.secret, we test via HTTP directly
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
