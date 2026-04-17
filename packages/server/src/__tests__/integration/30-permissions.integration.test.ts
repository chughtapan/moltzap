import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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
function registerWithOwner(
  name: string,
  userId: string,
): Effect.Effect<OwnedAgent, Error> {
  return Effect.gen(function* () {
    const app = getTestCoreApp();
    const baseUrl = `http://localhost:${app.port}`;
    const wsUrl = `ws://localhost:${app.port}/ws`;

    // Step 1: register the agent
    const regClient = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = yield* regClient.register(name);
    yield* regClient.close();

    // Step 2: set owner_user_id in DB
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: userId })
        .where("id", "=", reg.agentId)
        .execute(),
    );

    // Step 3: reconnect — auth/connect now reads the updated owner
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    trackClient(client);
    yield* client.connect(reg.apiKey);

    return { client, agentId: reg.agentId, apiKey: reg.apiKey };
  });
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
  it.live(
    "sends permissions/required event and admits agent after permissions/grant RPC",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerWithOwner("alice-pf", USER_ALICE);
        const bob = yield* registerWithOwner("bob-pf", USER_BOB);

        const session = (yield* alice.client.rpc("apps/create", {
          appId: "perm-test-app",
          invitedAgentIds: [bob.agentId],
        })) as { session: { id: string; status: string } };
        expect(session.session.status).toBe("waiting");

        const permEvent = yield* bob.client.waitForEvent(
          "permissions/required",
        );
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

        yield* bob.client.rpc("permissions/grant", {
          sessionId: perm.sessionId,
          agentId: bob.agentId,
          resource: "calendar",
          access: ["read", "write"],
        });

        const admitted = (yield* bob.client.waitForEvent(
          "app/participantAdmitted",
        )).data as {
          agentId: string;
          grantedResources: string[];
        };
        expect(admitted.agentId).toBe(bob.agentId);
        expect(admitted.grantedResources).toContain("calendar");

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );

  it.live("persists grant in DB and skips re-prompt on second session", () =>
    Effect.gen(function* () {
      const alice = yield* registerWithOwner("alice-c", USER_ALICE);
      const bob = yield* registerWithOwner("bob-c", USER_BOB);

      // Session 1: grant
      yield* alice.client.rpc("apps/create", {
        appId: "perm-test-app",
        invitedAgentIds: [bob.agentId],
      });
      const p1 = (yield* bob.client.waitForEvent("permissions/required"))
        .data as { sessionId: string };
      yield* bob.client.rpc("permissions/grant", {
        sessionId: p1.sessionId,
        agentId: bob.agentId,
        resource: "calendar",
        access: ["read", "write"],
      });
      yield* bob.client.waitForEvent("app/participantAdmitted");

      // Verify grant persisted
      const rows = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_permission_grants")
          .selectAll()
          .where("user_id", "=", USER_BOB)
          .where("app_id", "=", "perm-test-app")
          .execute(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resource).toBe("calendar");

      // Session 2: should be admitted immediately (cached grant)
      yield* alice.client.rpc("apps/create", {
        appId: "perm-test-app",
        invitedAgentIds: [bob.agentId],
      });
      yield* bob.client.waitForEvent("app/participantAdmitted");

      // Verify no permissions/required event was sent for the cached session.
      // Wait briefly then check — the event would have arrived before the
      // admitted event if it was going to come at all.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));
      const stray = bob.client
        .drainEvents()
        .filter((e) => e.event === "permissions/required");
      expect(stray).toHaveLength(0);

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});

describe("permissions/list and permissions/revoke RPCs", () => {
  it.live("lists and revokes grants end-to-end", () =>
    Effect.gen(function* () {
      const alice = yield* registerWithOwner("alice-lr", USER_ALICE);
      const bob = yield* registerWithOwner("bob-lr", USER_BOB);

      // Grant via session flow
      yield* alice.client.rpc("apps/create", {
        appId: "perm-test-app",
        invitedAgentIds: [bob.agentId],
      });
      const p = (yield* bob.client.waitForEvent("permissions/required"))
        .data as { sessionId: string };
      yield* bob.client.rpc("permissions/grant", {
        sessionId: p.sessionId,
        agentId: bob.agentId,
        resource: "calendar",
        access: ["read", "write"],
      });
      yield* bob.client.waitForEvent("app/participantAdmitted");

      // List
      const list = (yield* bob.client.rpc("permissions/list", {
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
      yield* bob.client.rpc("permissions/revoke", {
        appId: "perm-test-app",
        resource: "calendar",
      });

      // Verify empty
      const after = (yield* bob.client.rpc("permissions/list", {
        appId: "perm-test-app",
      })) as { grants: unknown[] };
      expect(after.grants).toHaveLength(0);

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});

describe("Permission rejection", () => {
  it.live("rejects with PermissionTimeout when grant is not sent in time", () =>
    Effect.gen(function* () {
      const shortManifest: AppManifest = {
        ...MANIFEST,
        appId: "timeout-app",
        permissionTimeoutMs: 1000,
      };
      getTestCoreApp().registerApp(shortManifest);

      const alice = yield* registerWithOwner("alice-to", USER_ALICE);
      const bob = yield* registerWithOwner("bob-to", USER_BOB);

      yield* alice.client.rpc("apps/create", {
        appId: "timeout-app",
        invitedAgentIds: [bob.agentId],
      });

      const rejected = (yield* bob.client.waitForEvent(
        "app/participantRejected",
        5000,
      )).data as {
        stage: string;
        rejectionCode: string;
      };
      expect(rejected.stage).toBe("permission");
      expect(rejected.rejectionCode).toBe("PermissionTimeout");

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});

describe("Set-containment: partial grant triggers re-prompt", () => {
  it.live(
    "re-prompts when stored grant covers fewer access rights than required",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerWithOwner("alice-sc", USER_ALICE);
        const bob = yield* registerWithOwner("bob-sc", USER_BOB);

        // Seed a partial grant: ["read"] for a ["read","write"] requirement
        yield* Effect.tryPromise(() =>
          db
            .insertInto("app_permission_grants")
            .values({
              user_id: USER_BOB,
              app_id: "perm-test-app",
              resource: "calendar",
              access: ["read"],
            })
            .execute(),
        );

        // Bob should still get prompted
        yield* alice.client.rpc("apps/create", {
          appId: "perm-test-app",
          invitedAgentIds: [bob.agentId],
        });

        const perm = (yield* bob.client.waitForEvent("permissions/required"))
          .data as {
          sessionId: string;
          resource: string;
          access: string[];
        };
        expect(perm.resource).toBe("calendar");
        expect(perm.access).toEqual(["read", "write"]);

        // Grant full access
        yield* bob.client.rpc("permissions/grant", {
          sessionId: perm.sessionId,
          agentId: bob.agentId,
          resource: "calendar",
          access: ["read", "write"],
        });
        yield* bob.client.waitForEvent("app/participantAdmitted");

        // DB should now have the upgraded grant
        const rows = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_permission_grants")
            .select("access")
            .where("user_id", "=", USER_BOB)
            .where("app_id", "=", "perm-test-app")
            .where("resource", "=", "calendar")
            .executeTakeFirst(),
        );
        expect(rows!.access).toEqual(["read", "write"]);

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );
});
