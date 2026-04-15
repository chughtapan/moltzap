import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

describe("Auth Failure", () => {
  it("bad API key is rejected with authentication error", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);

    await expect(client.connect("invalid_key_12345")).rejects.toThrow(
      "Authentication failed",
    );

    client.close();
  });

  it("unauthenticated RPC call is rejected", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);

    await expect(
      client.connect("mz_totally_fake_api_key_000000000000"),
    ).rejects.toThrow("Authentication failed");

    client.close();
  });

  it("suspended agent cannot call protected RPCs", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("suspended-agent");

    // Suspend via direct DB update
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
