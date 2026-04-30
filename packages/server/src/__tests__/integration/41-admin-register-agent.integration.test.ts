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
  connectTestClient,
} from "./helpers.js";

const REGISTRATION_SECRET = "admin-test-secret-zxcv";
// Arbitrary v4 UUID used as the "system user" identity in arena. moltzap's
// schema has no users table; this UUID is just a label that satisfies the
// AppHost null check on `agents.owner_user_id`.
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

const ADMIN_TEST_MANIFEST: AppManifest = {
  appId: "admin-register-test-app",
  name: "Admin Register Test App",
  // Empty permissions — admission auto-completes without prompting,
  // keeping this test focused on the owner-id check at app-host.ts:753.
  permissions: { required: [], optional: [] },
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

let baseUrl: string;
let wsUrl: string;
let db: Kysely<Database>;

beforeAll(async () => {
  const server = await startTestServer({
    registrationSecret: REGISTRATION_SECRET,
  });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
  db = getKyselyDb();
  getTestCoreApp().registerApp(ADMIN_TEST_MANIFEST);
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  getTestCoreApp().registerApp(ADMIN_TEST_MANIFEST);
});

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

async function postAdmin(
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/api/v1/admin/register-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // The endpoint always returns JSON (success or error envelopes).
  const json: unknown = await res.json();
  return { status: res.status, json };
}

describe("/api/v1/admin/register-agent — secret-gated ownerUserId", () => {
  it.live(
    "registers an agent with explicit ownerUserId when invite code matches",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise(() =>
          postAdmin({
            name: "admin-owned-agent",
            inviteCode: REGISTRATION_SECRET,
            ownerUserId: SYSTEM_USER_ID,
          }),
        );
        expect(result.status).toBe(201);
        const body = result.json as AdminRegisterResponse;
        expect(body.agentId).toBeDefined();
        expect(body.apiKey).toMatch(/^moltzap_agent_/);

        // The agent's owner_user_id is set at insert time — no UPDATE needed.
        const row = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select(["id", "owner_user_id", "name"])
            .where("id", "=", body.agentId)
            .executeTakeFirstOrThrow(),
        );
        expect(row.owner_user_id).toBe(SYSTEM_USER_ID);
        expect(row.name).toBe("admin-owned-agent");
      }),
  );

  it.live(
    "agent registered via admin endpoint passes AppHost owner check (no AgentNoOwner)",
    () =>
      Effect.gen(function* () {
        // Register two agents — one initiator, one invitee. Both pre-claimed
        // to SYSTEM_USER_ID via the admin route. AppHost.createSession
        // (`app-host.ts:753`) refuses agents with null `owner_user_id` with
        // `AgentNoOwner`; this test exercises the success path.
        const initiatorRes = yield* Effect.tryPromise(() =>
          postAdmin({
            name: "admin-initiator",
            inviteCode: REGISTRATION_SECRET,
            ownerUserId: SYSTEM_USER_ID,
          }),
        );
        expect(initiatorRes.status).toBe(201);
        const initiator = initiatorRes.json as AdminRegisterResponse;

        const inviteeRes = yield* Effect.tryPromise(() =>
          postAdmin({
            name: "admin-invitee",
            inviteCode: REGISTRATION_SECRET,
            ownerUserId: SYSTEM_USER_ID,
          }),
        );
        expect(inviteeRes.status).toBe(201);
        const invitee = inviteeRes.json as AdminRegisterResponse;

        // Connect the initiator and create a session — this drives the
        // owner_user_id check at app-host.ts:753.
        const client = yield* connectTestClient({
          wsUrl,
          agentId: initiator.agentId,
          apiKey: initiator.apiKey,
        });
        trackClient(client);

        const session = (yield* client.sendRpc("apps/create", {
          appId: ADMIN_TEST_MANIFEST.appId,
          invitedAgentIds: [invitee.agentId],
        })) as { session: { id: string; status: string } };

        expect(session.session.id).toBeDefined();
        expect(session.session.status).toBe("waiting");
      }),
  );

  it.live("rejects when invite code is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postAdmin({
          name: "no-invite-code",
          ownerUserId: SYSTEM_USER_ID,
        }),
      );
      expect(result.status).toBe(403);
    }),
  );

  it.live("rejects when invite code does not match registrationSecret", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postAdmin({
          name: "wrong-invite-code",
          inviteCode: "not-the-real-secret",
          ownerUserId: SYSTEM_USER_ID,
        }),
      );
      expect(result.status).toBe(403);
    }),
  );

  it.live("rejects ownerUserId that is not a UUID", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postAdmin({
          name: "bad-owner",
          inviteCode: REGISTRATION_SECRET,
          ownerUserId: "not-a-uuid",
        }),
      );
      expect(result.status).toBe(400);
      const body = result.json as { error: string };
      expect(body.error).toMatch(/UUID/);
    }),
  );

  it.live(
    "registers without ownerUserId — owner_user_id is null when omitted",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise(() =>
          postAdmin({
            name: "no-owner-agent",
            inviteCode: REGISTRATION_SECRET,
          }),
        );
        expect(result.status).toBe(201);
        const body = result.json as AdminRegisterResponse;

        const row = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select(["owner_user_id"])
            .where("id", "=", body.agentId)
            .executeTakeFirstOrThrow(),
        );
        // devModeUserId is not configured in this test harness, so owner is null.
        expect(row.owner_user_id).toBeNull();
      }),
  );
});

// The "registrationSecret-not-configured → 404" branch is exercised
// indirectly: the route's first action is to reject when the secret is
// unset. Adding a second harness boot for that single line would 2x the
// integration-test surface; the existing 32-registration-secret.integration.test.ts
// already covers the open-server path, and a unit-level assertion belongs in a
// follow-up if the surface grows.
