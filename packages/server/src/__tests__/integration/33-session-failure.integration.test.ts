import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Kysely } from "kysely";
import type { AppManifest } from "@moltzap/protocol";
import type { Database } from "../../db/database.js";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  getKyselyDb,
  getTestCoreApp,
  MoltZapTestClient,
  trackClient,
} from "./helpers.js";

let db: Kysely<Database>;

const USER_ALICE = "00000000-0000-4000-a000-000000000010";

const MANIFEST: AppManifest = {
  appId: "fail-test-app",
  name: "Session Failure Test",
  permissions: {
    required: [{ resource: "vault", access: ["read"] }],
    optional: [],
  },
  permissionTimeoutMs: 1000,
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

async function registerWithOwner(
  name: string,
  userId: string,
): Promise<{ client: MoltZapTestClient; agentId: string }> {
  const app = getTestCoreApp();
  const baseUrl = `http://localhost:${app.port}`;
  const wsUrl = `ws://localhost:${app.port}/ws`;

  const regClient = new MoltZapTestClient(baseUrl, wsUrl);
  const reg = await regClient.register(name);
  regClient.close();

  await db
    .updateTable("agents")
    .set({ owner_user_id: userId })
    .where("id", "=", reg.agentId)
    .execute();

  const client = new MoltZapTestClient(baseUrl, wsUrl);
  trackClient(client);
  await client.connect(reg.apiKey);

  return { client, agentId: reg.agentId };
}

beforeAll(async () => {
  await startTestServer();
  db = getKyselyDb();
  getTestCoreApp().registerApp(MANIFEST);
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  getTestCoreApp().registerApp(MANIFEST);
});

describe("Session failure state", () => {
  it("emits app/sessionFailed when all invited agents are rejected", async () => {
    const alice = await registerWithOwner("alice-sf", USER_ALICE);

    // Invite an agent that doesn't exist — will be rejected at identity stage
    const failedPromise = alice.client.waitForEvent("app/sessionFailed", 5000);

    await alice.client.rpc("apps/create", {
      appId: "fail-test-app",
      invitedAgentIds: ["00000000-0000-4000-dead-000000000001"],
    });

    const event = await failedPromise;
    expect(event.data).toHaveProperty("sessionId");

    // The DB update is async (fire-and-forget from checkDone), give it a moment
    await new Promise((r) => setTimeout(r, 200));

    const session = await db
      .selectFrom("app_sessions")
      .select("status")
      .where("id", "=", (event.data as { sessionId: string }).sessionId)
      .executeTakeFirst();
    expect(session?.status).toBe("failed");

    alice.client.close();
  });

  it("emits app/sessionReady when at least one agent is admitted", async () => {
    const alice = await registerWithOwner("alice-sr", USER_ALICE);
    const bob = await registerWithOwner("bob-sr", USER_ALICE);

    // Bob doesn't need permission since we're using the same owner
    // But the manifest requires "vault" permission, so bob will timeout
    // Actually, let's use a manifest without required permissions for this test
    const noPermManifest: AppManifest = {
      appId: "no-perm-app",
      name: "No Permission App",
      permissions: { required: [], optional: [] },
      conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
    };
    getTestCoreApp().registerApp(noPermManifest);

    const readyPromise = alice.client.waitForEvent("app/sessionReady", 5000);

    await alice.client.rpc("apps/create", {
      appId: "no-perm-app",
      invitedAgentIds: [bob.agentId],
    });

    const event = await readyPromise;
    expect(event.data).toHaveProperty("sessionId");
    expect(event.data).toHaveProperty("conversations");

    alice.client.close();
    bob.client.close();
  });

  it("sets session status to active when mixed admit/reject", async () => {
    const alice = await registerWithOwner("alice-mx", USER_ALICE);

    // Register a real agent (will pass) and use a fake ID (will fail)
    const noPermManifest: AppManifest = {
      appId: "mixed-app",
      name: "Mixed App",
      permissions: { required: [], optional: [] },
      conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
    };
    getTestCoreApp().registerApp(noPermManifest);

    const bob = await registerWithOwner("bob-mx", USER_ALICE);

    const readyPromise = alice.client.waitForEvent("app/sessionReady", 5000);

    const result = await alice.client.rpc("apps/create", {
      appId: "mixed-app",
      invitedAgentIds: [bob.agentId, "00000000-0000-4000-dead-000000000002"],
    });

    const event = await readyPromise;
    const sessionId = (event.data as { sessionId: string }).sessionId;
    expect(sessionId).toBeDefined();

    // sessionReady event means at least one agent was admitted — status update is async
    // Give the DB update a moment to land
    await new Promise((r) => setTimeout(r, 200));

    const session = await db
      .selectFrom("app_sessions")
      .select("status")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    expect(session?.status).toBe("active");

    alice.client.close();
    bob.client.close();
  });
});
