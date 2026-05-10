import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { Kysely } from "kysely";
import { PROTOCOL_VERSION, type AppManifest } from "@moltzap/protocol";
import type { Database } from "../../../db/database.js";
import { parseApiKey } from "../../../auth/agent-auth.js";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  getKyselyDb,
  getTestCoreApp,
  postJson,
  trackClient,
  connectTestClient,
  registerAgent,
} from "../helpers.js";

import { Connect } from "@moltzap/protocol";

const REGISTRATION_SECRET = "admin-test-secret-zxcv";
// Arbitrary v4 UUID used as the "system user" identity in arena. moltzap's
// schema has no users table; this UUID is just a label that satisfies the
// AppHost null check on `agents.owner_user_id`.
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";

const ADMIN_TEST_MANIFEST: AppManifest = {
  appId: "admin-register-test-app",
  name: "Admin Register Test App",
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

const postAdmin = (body: Record<string, unknown>) =>
  postJson(baseUrl, "/api/v1/admin/register-agent", body);

/** Effect-lifted POST to the admin route with `inviteCode` pre-applied. */
function adminRegister(
  body: Record<string, unknown>,
): Effect.Effect<{ status: number; json: unknown }, Error> {
  return Effect.tryPromise(() =>
    postAdmin({ inviteCode: REGISTRATION_SECRET, ...body }),
  );
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

  // Phase 7 cutover removed `apps/create` and `AppHost.createSession`
  // along with the owner_user_id admission check at the legacy
  // `app-host.ts:753`. The equivalent task-bootstrap admission flow
  // moves to Phase 9's TM topology; reactivate this test then.
  it.todo(
    "agent registered via admin endpoint passes task-bootstrap owner check (Phase 9 reactivation)",
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

  // ───────────────────────── reentrant upsert (#373) ─────────────────────────

  it.live(
    "re-register same (name, ownerUserId): same agentId, fresh apiKey, status 200",
    () =>
      Effect.gen(function* () {
        const first = yield* adminRegister({
          name: "rotating-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(first.status).toBe(201);
        const firstBody = first.json as AdminRegisterResponse;

        const second = yield* adminRegister({
          name: "rotating-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(second.status).toBe(200);
        const secondBody = second.json as AdminRegisterResponse;

        expect(secondBody.agentId).toBe(firstBody.agentId);
        expect(secondBody.apiKey).not.toBe(firstBody.apiKey);
        expect(secondBody.apiKey).toMatch(/^moltzap_agent_/);
      }),
  );

  it.live("old apiKey is rejected by network/connect after re-register", () =>
    Effect.gen(function* () {
      const first = yield* adminRegister({
        name: "rotated-key-rejection",
        ownerUserId: SYSTEM_USER_ID,
      });
      expect(first.status).toBe(201);
      const oldKey = (first.json as AdminRegisterResponse).apiKey;

      const second = yield* adminRegister({
        name: "rotated-key-rejection",
        ownerUserId: SYSTEM_USER_ID,
      });
      expect(second.status).toBe(200);
      const rotated = second.json as AdminRegisterResponse;
      expect(rotated.apiKey).not.toBe(oldKey);

      // Old key's api_key_id no longer matches any row → network/connect fails.
      const staleClient = yield* connectTestClient({
        wsUrl,
        agentId: rotated.agentId,
        apiKey: oldKey,
        autoConnect: false,
      });
      trackClient(staleClient);
      const staleResult = yield* Effect.exit(
        staleClient.sendRpc(Connect, {
          agentKey: oldKey,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        }),
      );
      expect(staleResult._tag).toBe("Failure");

      const freshClient = yield* connectTestClient({
        wsUrl,
        agentId: rotated.agentId,
        apiKey: rotated.apiKey,
        autoConnect: false,
      });
      trackClient(freshClient);
      const hello = (yield* freshClient.sendRpc(Connect, {
        agentKey: rotated.apiKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      })) as { agentId: string };
      expect(hello.agentId).toBe(rotated.agentId);
    }),
  );

  it.live("re-register with mismatched ownerUserId returns 409", () =>
    Effect.gen(function* () {
      const first = yield* adminRegister({
        name: "owner-mismatch-agent",
        ownerUserId: SYSTEM_USER_ID,
      });
      expect(first.status).toBe(201);

      const second = yield* adminRegister({
        name: "owner-mismatch-agent",
        ownerUserId: OTHER_USER_ID,
      });
      expect(second.status).toBe(409);
      expect((second.json as { code?: string }).code).toBe(
        "REGISTRATION_CONFLICT",
      );
    }),
  );

  it.live(
    "re-register without ownerUserId on a row that has one returns 409",
    () =>
      Effect.gen(function* () {
        const first = yield* adminRegister({
          name: "drop-owner-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(first.status).toBe(201);

        // IS NOT DISTINCT FROM treats NULL ≠ <uuid>; upsert is rejected.
        const second = yield* adminRegister({ name: "drop-owner-agent" });
        expect(second.status).toBe(409);
      }),
  );

  it.live(
    "re-register on a suspended agent returns 409 (does not silently re-arm)",
    () =>
      Effect.gen(function* () {
        const first = yield* adminRegister({
          name: "suspended-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(first.status).toBe(201);
        const firstBody = first.json as AdminRegisterResponse;

        yield* Effect.tryPromise(() =>
          db
            .updateTable("agents")
            .set({ status: "suspended" })
            .where("id", "=", firstBody.agentId)
            .execute(),
        );

        const second = yield* adminRegister({
          name: "suspended-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(second.status).toBe(409);

        const row = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select(["status"])
            .where("id", "=", firstBody.agentId)
            .executeTakeFirstOrThrow(),
        );
        expect(row.status).toBe("suspended");
      }),
  );

  it.live(
    "concurrent re-register: both calls succeed, both return same agentId",
    () =>
      Effect.gen(function* () {
        // Seed the row so both concurrent calls hit the UPDATE branch
        // (where row-lock serialization matters). Two concurrent INSERTs
        // with no prior row race on the unique constraint and one would
        // fail — that race isn't the contract under test.
        const seed = yield* adminRegister({
          name: "concurrent-rotate-agent",
          ownerUserId: SYSTEM_USER_ID,
        });
        expect(seed.status).toBe(201);
        const seedBody = seed.json as AdminRegisterResponse;

        const [a, b] = yield* Effect.all(
          [
            adminRegister({
              name: "concurrent-rotate-agent",
              ownerUserId: SYSTEM_USER_ID,
            }),
            adminRegister({
              name: "concurrent-rotate-agent",
              ownerUserId: SYSTEM_USER_ID,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const aBody = a.json as AdminRegisterResponse;
        const bBody = b.json as AdminRegisterResponse;

        expect(aBody.agentId).toBe(seedBody.agentId);
        expect(bBody.agentId).toBe(seedBody.agentId);
        expect(aBody.apiKey).not.toBe(bBody.apiKey);

        // Whichever transaction committed last is the live key — Postgres
        // row-lock ordering is non-deterministic, so we only assert that
        // the live key matches one of the two callers (not which one).
        const liveRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select(["api_key_id"])
            .where("id", "=", seedBody.agentId)
            .executeTakeFirstOrThrow(),
        );
        const aKeyId = parseApiKey(aBody.apiKey)?.keyId;
        const bKeyId = parseApiKey(bBody.apiKey)?.keyId;
        expect([aKeyId, bKeyId]).toContain(liveRow.api_key_id);
      }),
  );

  it.live(
    "regression: public /auth/register stays insert-only (duplicate name fails)",
    () =>
      // Architect spec #373 decision 5: reentrancy on the public route
      // would let any REGISTRATION_SECRET holder rotate any existing
      // agent's apiKey. The public route has no owner-match WHERE.
      Effect.gen(function* () {
        yield* registerAgent(baseUrl, "public-route-insert-only", {
          inviteCode: REGISTRATION_SECRET,
        });
        const dup = yield* Effect.exit(
          registerAgent(baseUrl, "public-route-insert-only", {
            inviteCode: REGISTRATION_SECRET,
          }),
        );
        expect(dup._tag).toBe("Failure");
      }),
  );
});

// The "registrationSecret-not-configured → 404" branch is exercised
// indirectly: the route's first action is to reject when the secret is
// unset. Adding a second harness boot for that single line would 2x the
// integration-test surface; the existing 32-registration-secret.integration.test.ts
// already covers the open-server path, and a unit-level assertion belongs in a
// follow-up if the surface grows.
