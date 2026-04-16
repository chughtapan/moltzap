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

// Stable UUIDs for test users (owner_user_id is a UUID column)
const USER_ALICE = "00000000-0000-4000-a000-000000000001";
const USER_BOB = "00000000-0000-4000-a000-000000000002";

const MANIFEST: AppManifest = {
  appId: "perm-test-app",
  name: "Permission Test App",
  permissions: {
    required: [{ resource: "calendar", access: ["read", "write"] }],
    optional: [{ resource: "contacts", access: ["read"] }],
  },
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

interface OwnedAgent {
  client: MoltZapTestClient;
  agentId: string;
  apiKey: string;
}

/**
 * Register an agent, set owner_user_id, then reconnect so auth context has the owner.
 * Two-step because register creates agent with null owner, and auth/connect reads it at connect time.
 */
async function registerWithOwner(
  name: string,
  userId: string,
): Promise<OwnedAgent> {
  const app = getTestCoreApp();
  const baseUrl = `http://localhost:${app.port}`;
  const wsUrl = `ws://localhost:${app.port}/ws`;

  // Step 1: register the agent
  const regClient = new MoltZapTestClient(baseUrl, wsUrl);
  const reg = await regClient.register(name);
  regClient.close();

  // Step 2: set owner_user_id in DB
  await db
    .updateTable("agents")
    .set({ owner_user_id: userId })
    .where("id", "=", reg.agentId)
    .execute();

  // Step 3: reconnect — auth/connect now reads the updated owner
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  trackClient(client);
  await client.connect(reg.apiKey);

  return { client, agentId: reg.agentId, apiKey: reg.apiKey };
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

describe("Permission grant flow (DefaultPermissionService)", () => {
  it("sends permissions/required event and admits agent after permissions/grant RPC", async () => {
    const alice = await registerWithOwner("alice-pf", USER_ALICE);
    const bob = await registerWithOwner("bob-pf", USER_BOB);

    const permPromise = bob.client.waitForEvent("permissions/required");

    const session = (await alice.client.rpc("apps/create", {
      appId: "perm-test-app",
      invitedAgentIds: [bob.agentId],
    })) as { session: { id: string; status: string } };
    expect(session.session.status).toBe("waiting");

    const permEvent = await permPromise;
    const perm = permEvent.data as {
      sessionId: string;
      appId: string;
      resource: string;
      access: string[];
      targetUserId: string;
    };
    expect(perm.appId).toBe("perm-test-app");
    expect(perm.resource).toBe("calendar");
    expect(perm.access).toEqual(["read", "write"]);
    expect(perm.targetUserId).toBe(USER_BOB);

    const admittedPromise = bob.client.waitForEvent("app/participantAdmitted");

    await bob.client.rpc("permissions/grant", {
      sessionId: perm.sessionId,
      agentId: bob.agentId,
      resource: "calendar",
      access: ["read", "write"],
    });

    const admitted = (await admittedPromise).data as {
      agentId: string;
      grantedResources: string[];
    };
    expect(admitted.agentId).toBe(bob.agentId);
    expect(admitted.grantedResources).toContain("calendar");

    alice.client.close();
    bob.client.close();
  });

  it("persists grant in DB and skips re-prompt on second session", async () => {
    const alice = await registerWithOwner("alice-c", USER_ALICE);
    const bob = await registerWithOwner("bob-c", USER_BOB);

    // Session 1: grant
    const perm1 = bob.client.waitForEvent("permissions/required");
    await alice.client.rpc("apps/create", {
      appId: "perm-test-app",
      invitedAgentIds: [bob.agentId],
    });
    const p1 = (await perm1).data as { sessionId: string };
    const admitted1 = bob.client.waitForEvent("app/participantAdmitted");
    await bob.client.rpc("permissions/grant", {
      sessionId: p1.sessionId,
      agentId: bob.agentId,
      resource: "calendar",
      access: ["read", "write"],
    });
    await admitted1;

    // Verify grant persisted
    const rows = await db
      .selectFrom("app_permission_grants")
      .selectAll()
      .where("user_id", "=", USER_BOB)
      .where("app_id", "=", "perm-test-app")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource).toBe("calendar");

    // Session 2: should be admitted immediately (cached grant)
    const admitted2 = bob.client.waitForEvent("app/participantAdmitted");
    await alice.client.rpc("apps/create", {
      appId: "perm-test-app",
      invitedAgentIds: [bob.agentId],
    });
    await admitted2;

    // Verify no permissions/required event was sent for the cached session.
    // Wait briefly then check — the event would have arrived before the
    // admitted event if it was going to come at all.
    await new Promise((r) => setTimeout(r, 200));
    const stray = bob.client
      .drainEvents()
      .filter((e) => e.event === "permissions/required");
    expect(stray).toHaveLength(0);

    alice.client.close();
    bob.client.close();
  });
});

describe("permissions/list and permissions/revoke RPCs", () => {
  it("lists and revokes grants end-to-end", async () => {
    const alice = await registerWithOwner("alice-lr", USER_ALICE);
    const bob = await registerWithOwner("bob-lr", USER_BOB);

    // Grant via session flow
    const permPromise = bob.client.waitForEvent("permissions/required");
    await alice.client.rpc("apps/create", {
      appId: "perm-test-app",
      invitedAgentIds: [bob.agentId],
    });
    const p = (await permPromise).data as { sessionId: string };
    const admittedPromise = bob.client.waitForEvent("app/participantAdmitted");
    await bob.client.rpc("permissions/grant", {
      sessionId: p.sessionId,
      agentId: bob.agentId,
      resource: "calendar",
      access: ["read", "write"],
    });
    await admittedPromise;

    // List
    const list = (await bob.client.rpc("permissions/list", {
      appId: "perm-test-app",
    })) as {
      grants: Array<{
        appId: string;
        resource: string;
        access: string[];
        grantedAt: string;
      }>;
    };
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0]!.resource).toBe("calendar");
    expect(list.grants[0]!.access).toEqual(["read", "write"]);
    expect(list.grants[0]!.grantedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Revoke
    await bob.client.rpc("permissions/revoke", {
      appId: "perm-test-app",
      resource: "calendar",
    });

    // Verify empty
    const after = (await bob.client.rpc("permissions/list", {
      appId: "perm-test-app",
    })) as { grants: unknown[] };
    expect(after.grants).toHaveLength(0);

    alice.client.close();
    bob.client.close();
  });
});

describe("Permission rejection", () => {
  it("rejects with PermissionTimeout when grant is not sent in time", async () => {
    const shortManifest: AppManifest = {
      ...MANIFEST,
      appId: "timeout-app",
      permissionTimeoutMs: 1000,
    };
    getTestCoreApp().registerApp(shortManifest);

    const alice = await registerWithOwner("alice-to", USER_ALICE);
    const bob = await registerWithOwner("bob-to", USER_BOB);

    const rejectedPromise = bob.client.waitForEvent(
      "app/participantRejected",
      5000,
    );

    await alice.client.rpc("apps/create", {
      appId: "timeout-app",
      invitedAgentIds: [bob.agentId],
    });

    const rejected = (await rejectedPromise).data as {
      stage: string;
      rejectionCode: string;
    };
    expect(rejected.stage).toBe("permission");
    expect(rejected.rejectionCode).toBe("PermissionTimeout");

    alice.client.close();
    bob.client.close();
  });
});

describe("Set-containment: partial grant triggers re-prompt", () => {
  it("re-prompts when stored grant covers fewer access rights than required", async () => {
    const alice = await registerWithOwner("alice-sc", USER_ALICE);
    const bob = await registerWithOwner("bob-sc", USER_BOB);

    // Seed a partial grant: ["read"] for a ["read","write"] requirement
    await db
      .insertInto("app_permission_grants")
      .values({
        user_id: USER_BOB,
        app_id: "perm-test-app",
        resource: "calendar",
        access: ["read"],
      })
      .execute();

    // Bob should still get prompted
    const permPromise = bob.client.waitForEvent("permissions/required");
    await alice.client.rpc("apps/create", {
      appId: "perm-test-app",
      invitedAgentIds: [bob.agentId],
    });

    const perm = (await permPromise).data as {
      sessionId: string;
      resource: string;
      access: string[];
    };
    expect(perm.resource).toBe("calendar");
    expect(perm.access).toEqual(["read", "write"]);

    // Grant full access
    const admittedPromise = bob.client.waitForEvent("app/participantAdmitted");
    await bob.client.rpc("permissions/grant", {
      sessionId: perm.sessionId,
      agentId: bob.agentId,
      resource: "calendar",
      access: ["read", "write"],
    });
    await admittedPromise;

    // DB should now have the upgraded grant
    const rows = await db
      .selectFrom("app_permission_grants")
      .select("access")
      .where("user_id", "=", USER_BOB)
      .where("app_id", "=", "perm-test-app")
      .where("resource", "=", "calendar")
      .executeTakeFirst();
    expect(rows!.access).toEqual(["read", "write"]);

    alice.client.close();
    bob.client.close();
  });
});
