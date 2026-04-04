import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
} from "./helpers.js";
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
  it("registers an agent and returns API key", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("test-agent");

    expect(reg.agentId).toBeDefined();
    expect(reg.apiKey).toMatch(/^moltzap_agent_/);

    client.close();
  });

  it("rejects duplicate agent names", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    await client.register("unique-agent");

    await expect(client.register("unique-agent")).rejects.toThrow();

    client.close();
  });

  it("registered agent is active immediately and can use all methods", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("active-agent");

    const hello = (await client.connect(reg.apiKey)) as Record<string, unknown>;
    expect(hello.protocolVersion).toBeDefined();
    expect(hello.agentId).toBe(reg.agentId);

    const result = (await client.rpc("conversations/list", {})) as {
      conversations: unknown[];
    };
    expect(result.conversations).toEqual([]);

    client.close();
  });

  it("suspended agent cannot connect", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("suspended-agent");

    const db = getCoreDb();
    await db
      .updateTable("agents")
      .set({ status: "suspended" })
      .where("id", "=", reg.agentId)
      .execute();

    await expect(client.connect(reg.apiKey)).rejects.toThrow();

    client.close();
  });
});
