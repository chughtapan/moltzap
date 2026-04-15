import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";

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
  it("suspended agent cannot connect", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("suspend-agent");

    // Suspend the agent via DB
    const db = getKyselyDb();
    await db
      .updateTable("agents")
      .set({ status: "suspended" })
      .where("id", "=", reg.agentId)
      .execute();

    // Cannot connect
    await expect(client.connect(reg.apiKey)).rejects.toThrow(
      "Authentication failed",
    );

    client.close();
  });

  it("active agent works normally after registration", async () => {
    const { client } = await registerAndConnect("active-agent");

    // Should work immediately — agents are active on registration in core
    const result = (await client.rpc("conversations/list", {})) as {
      conversations: unknown[];
    };
    expect(result.conversations).toEqual([]);

    client.close();
  });
});
