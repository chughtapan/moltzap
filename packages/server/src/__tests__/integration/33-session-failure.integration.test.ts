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
  trackClient,
  registerAgent,
  connectTestClient,
  type ServerTestClient,
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

function registerWithOwner(
  name: string,
  userId: string,
): Effect.Effect<{ client: ServerTestClient; agentId: string }, Error> {
  return Effect.gen(function* () {
    const app = getTestCoreApp();
    const baseUrl = `http://localhost:${app.port}`;
    const wsUrl = `ws://localhost:${app.port}/ws`;

    const reg = yield* registerAgent(baseUrl, name);

    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: userId })
        .where("id", "=", reg.agentId)
        .execute(),
    );

    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);

    return { client, agentId: reg.agentId };
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

describe("Session failure state", () => {
  it.live("emits app/sessionFailed when all invited agents are rejected", () =>
    Effect.gen(function* () {
      const alice = yield* registerWithOwner("alice-sf", USER_ALICE);

      // Invite an agent that doesn't exist — will be rejected at identity stage
      yield* alice.client.sendRpc("apps/create", {
        appId: "fail-test-app",
        invitedAgentIds: ["00000000-0000-4000-dead-000000000001"],
      });

      const event = yield* alice.client.waitForEvent("app/sessionFailed", 5000);
      expect(event.data).toHaveProperty("sessionId");

      // The DB update is async (fire-and-forget from checkDone), give it a moment
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));

      const session = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_sessions")
          .select("status")
          .where("id", "=", (event.data as { sessionId: string }).sessionId)
          .executeTakeFirst(),
      );
      expect(session?.status).toBe("failed");

      yield* alice.client.close();
    }),
  );

  it.live("emits app/sessionReady when at least one agent is admitted", () =>
    Effect.gen(function* () {
      const alice = yield* registerWithOwner("alice-sr", USER_ALICE);
      const bob = yield* registerWithOwner("bob-sr", USER_ALICE);

      // Bob doesn't need permission since we're using the same owner
      // But the manifest requires "vault" permission, so bob will timeout
      // Actually, let's use a manifest without required permissions for this test
      const noPermManifest: AppManifest = {
        appId: "no-perm-app",
        name: "No Permission App",
        permissions: { required: [], optional: [] },
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
      };
      getTestCoreApp().registerApp(noPermManifest);

      yield* alice.client.sendRpc("apps/create", {
        appId: "no-perm-app",
        invitedAgentIds: [bob.agentId],
      });

      const event = yield* alice.client.waitForEvent("app/sessionReady", 5000);
      expect(event.data).toHaveProperty("sessionId");
      expect(event.data).toHaveProperty("conversations");

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );

  it.live("sets session status to active when mixed admit/reject", () =>
    Effect.gen(function* () {
      const alice = yield* registerWithOwner("alice-mx", USER_ALICE);

      // Register a real agent (will pass) and use a fake ID (will fail)
      const noPermManifest: AppManifest = {
        appId: "mixed-app",
        name: "Mixed App",
        permissions: { required: [], optional: [] },
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
      };
      getTestCoreApp().registerApp(noPermManifest);

      const bob = yield* registerWithOwner("bob-mx", USER_ALICE);

      yield* alice.client.sendRpc("apps/create", {
        appId: "mixed-app",
        invitedAgentIds: [bob.agentId, "00000000-0000-4000-dead-000000000002"],
      });

      const event = yield* alice.client.waitForEvent("app/sessionReady", 5000);
      const sessionId = (event.data as { sessionId: string }).sessionId;
      expect(sessionId).toBeDefined();

      // sessionReady event means at least one agent was admitted — status update is async
      // Give the DB update a moment to land
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));

      const session = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_sessions")
          .select("status")
          .where("id", "=", sessionId)
          .executeTakeFirst(),
      );
      expect(session?.status).toBe("active");

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});
