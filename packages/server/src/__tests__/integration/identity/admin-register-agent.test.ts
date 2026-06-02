import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect, Exit } from "effect";
import { Connect, PROTOCOL_VERSION } from "@moltzap/protocol";
import { agentId } from "@moltzap/protocol/testing";
import { parseApiKey } from "../../../identity/services/agent-auth.js";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  getKyselyDb,
  postJson,
  trackClient,
  connectTestClient,
  registerAgent,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_CREATED,
  HTTP_FORBIDDEN,
  HTTP_OK,
} from "../helpers.js";

const it = effectIt.live;

const REGISTRATION_SECRET = "admin-test-secret-zxcv";
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const ADMIN_OWNED_AGENT_NAME = "admin-owned-agent";
const ROTATING_AGENT_NAME = "rotating-agent";
const ROTATED_KEY_AGENT_NAME = "rotated-key-rejection";
const OWNER_MISMATCH_AGENT_NAME = "owner-mismatch-agent";
const DROP_OWNER_AGENT_NAME = "drop-owner-agent";
const SUSPENDED_AGENT_NAME = "suspended-agent";
const CONCURRENT_AGENT_NAME = "concurrent-rotate-agent";
const PUBLIC_INSERT_ONLY_AGENT_NAME = "public-route-insert-only";
const REGISTRATION_CONFLICT_CODE = "REGISTRATION_CONFLICT";
const AGENT_STATUS_SUSPENDED = "suspended";
const API_KEY_PATTERN = /^moltzap_agent_/;
const CONCURRENT_ROTATION_CALLS = 2;

let baseUrl: string;
let wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    startTestServerEffect({
      registrationSecret: REGISTRATION_SECRET,
    }).pipe(
      Effect.tap((server) =>
        Effect.sync(() => {
          baseUrl = server.baseUrl;
          wsUrl = server.wsUrl;
        }),
      ),
    ),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

type ConnectedTestClient =
  ReturnType<typeof connectTestClient> extends Effect.Effect<infer A, infer _E>
    ? A
    : never;

function postAdmin(body: Record<string, unknown>) {
  return postJson(baseUrl, "/api/v1/admin/register-agent", body);
}

function adminRegister(body: Record<string, unknown>) {
  return postAdmin({ inviteCode: REGISTRATION_SECRET, ...body });
}

function adminRegisterOwned(
  name: string,
  ownerUserId: string = SYSTEM_USER_ID,
) {
  return adminRegister({ name, ownerUserId });
}

function adminResponse(json: unknown) {
  return json as AdminRegisterResponse;
}

function selectAgentIdentity(id: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("agents")
      .select(["id", "owner_user_id", "name"])
      .where("id", "=", agentId(id))
      .executeTakeFirstOrThrow(),
  );
}

function selectAgentOwner(id: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("agents")
      .select(["owner_user_id"])
      .where("id", "=", agentId(id))
      .executeTakeFirstOrThrow(),
  ).pipe(Effect.map((row) => row.owner_user_id));
}

function selectAgentStatus(id: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("agents")
      .select(["status"])
      .where("id", "=", agentId(id))
      .executeTakeFirstOrThrow(),
  ).pipe(Effect.map((row) => row.status));
}

function selectLiveApiKeyId(id: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("agents")
      .select(["api_key_id"])
      .where("id", "=", agentId(id))
      .executeTakeFirstOrThrow(),
  ).pipe(Effect.map((row) => row.api_key_id));
}

function suspendAgent(id: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .updateTable("agents")
      .set({ status: AGENT_STATUS_SUSPENDED })
      .where("id", "=", agentId(id))
      .execute(),
  ).pipe(Effect.asVoid);
}

function connectManually(agentId: string, apiKey: string) {
  return Effect.gen(function* () {
    const client = yield* connectTestClient({
      wsUrl,
      agentId,
      apiKey,
      autoConnect: false,
    });
    trackClient(client);
    return client;
  });
}

function sendConnect(client: ConnectedTestClient, key: string) {
  return client.sendRpc(Connect, {
    credential: key,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  });
}

function registersExplicitOwner() {
  return Effect.gen(function* () {
    const result = yield* postAdmin({
      name: ADMIN_OWNED_AGENT_NAME,
      inviteCode: REGISTRATION_SECRET,
      ownerUserId: SYSTEM_USER_ID,
    });
    expect(result.status).toBe(HTTP_CREATED);
    const body = adminResponse(result.json);
    expect(body.agentId).toBeDefined();
    expect(body.apiKey).toMatch(API_KEY_PATTERN);

    const row = yield* selectAgentIdentity(body.agentId);
    expect(row.owner_user_id).toBe(SYSTEM_USER_ID);
    expect(row.name).toBe(ADMIN_OWNED_AGENT_NAME);
  });
}

function registersWithoutOwner() {
  return Effect.gen(function* () {
    const result = yield* postAdmin({
      name: "no-owner-agent",
      inviteCode: REGISTRATION_SECRET,
    });
    expect(result.status).toBe(HTTP_CREATED);
    const body = adminResponse(result.json);

    const ownerUserId = yield* selectAgentOwner(body.agentId);
    expect(ownerUserId).toBeNull();
  });
}

function rejectsMissingInviteCode() {
  return Effect.gen(function* () {
    const result = yield* postAdmin({
      name: "no-invite-code",
      ownerUserId: SYSTEM_USER_ID,
    });
    expect(result.status).toBe(HTTP_FORBIDDEN);
  });
}

function rejectsWrongInviteCode() {
  return Effect.gen(function* () {
    const result = yield* postAdmin({
      name: "wrong-invite-code",
      inviteCode: "not-the-real-secret",
      ownerUserId: SYSTEM_USER_ID,
    });
    expect(result.status).toBe(HTTP_FORBIDDEN);
  });
}

function rejectsInvalidOwnerUserId() {
  return Effect.gen(function* () {
    const result = yield* postAdmin({
      name: "bad-owner",
      inviteCode: REGISTRATION_SECRET,
      ownerUserId: "not-a-uuid",
    });
    expect(result.status).toBe(HTTP_BAD_REQUEST);
    const body = result.json as { error: string };
    expect(body.error).toMatch(/UUID/);
  });
}

function reregistersSameOwner() {
  return Effect.gen(function* () {
    const first = yield* adminRegisterOwned(ROTATING_AGENT_NAME);
    expect(first.status).toBe(HTTP_CREATED);
    const firstBody = adminResponse(first.json);

    const second = yield* adminRegisterOwned(ROTATING_AGENT_NAME);
    expect(second.status).toBe(HTTP_OK);
    const secondBody = adminResponse(second.json);

    expect(secondBody.agentId).toBe(firstBody.agentId);
    expect(secondBody.apiKey).not.toBe(firstBody.apiKey);
    expect(secondBody.apiKey).toMatch(API_KEY_PATTERN);
  });
}

function rejectsOldApiKeyAfterReregister() {
  return Effect.gen(function* () {
    const first = yield* adminRegisterOwned(ROTATED_KEY_AGENT_NAME);
    expect(first.status).toBe(HTTP_CREATED);
    const oldKey = adminResponse(first.json).apiKey;

    const second = yield* adminRegisterOwned(ROTATED_KEY_AGENT_NAME);
    expect(second.status).toBe(HTTP_OK);
    const rotated = adminResponse(second.json);
    expect(rotated.apiKey).not.toBe(oldKey);

    const staleClient = yield* connectManually(rotated.agentId, oldKey);
    const staleResult = yield* Effect.exit(sendConnect(staleClient, oldKey));
    expect(Exit.isFailure(staleResult)).toBe(true);

    const freshClient = yield* connectManually(rotated.agentId, rotated.apiKey);
    const hello = yield* sendConnect(freshClient, rotated.apiKey);
    // The HelloOk is empty: a successful connect is the only signal.
    expect(hello).toEqual({});
  });
}

function rejectsMismatchedOwnerOnReregister() {
  return Effect.gen(function* () {
    const first = yield* adminRegisterOwned(OWNER_MISMATCH_AGENT_NAME);
    expect(first.status).toBe(HTTP_CREATED);

    const second = yield* adminRegisterOwned(
      OWNER_MISMATCH_AGENT_NAME,
      OTHER_USER_ID,
    );
    expect(second.status).toBe(HTTP_CONFLICT);
    expect((second.json as { code?: string }).code).toBe(
      REGISTRATION_CONFLICT_CODE,
    );
  });
}

function rejectsDroppedOwnerOnReregister() {
  return Effect.gen(function* () {
    const first = yield* adminRegisterOwned(DROP_OWNER_AGENT_NAME);
    expect(first.status).toBe(HTTP_CREATED);

    const second = yield* adminRegister({ name: DROP_OWNER_AGENT_NAME });
    expect(second.status).toBe(HTTP_CONFLICT);
  });
}

function rejectsSuspendedAgentReregister() {
  return Effect.gen(function* () {
    const first = yield* adminRegisterOwned(SUSPENDED_AGENT_NAME);
    expect(first.status).toBe(HTTP_CREATED);
    const firstBody = adminResponse(first.json);

    yield* suspendAgent(firstBody.agentId);

    const second = yield* adminRegisterOwned(SUSPENDED_AGENT_NAME);
    expect(second.status).toBe(HTTP_CONFLICT);

    const status = yield* selectAgentStatus(firstBody.agentId);
    expect(status).toBe(AGENT_STATUS_SUSPENDED);
  });
}

function concurrentReregisterReturnsSameAgentId() {
  return Effect.gen(function* () {
    const seed = yield* adminRegisterOwned(CONCURRENT_AGENT_NAME);
    expect(seed.status).toBe(HTTP_CREATED);
    const seedBody = adminResponse(seed.json);

    const [a, b] = yield* Effect.all(
      [
        adminRegisterOwned(CONCURRENT_AGENT_NAME),
        adminRegisterOwned(CONCURRENT_AGENT_NAME),
      ],
      { concurrency: CONCURRENT_ROTATION_CALLS },
    );
    expect(a.status).toBe(HTTP_OK);
    expect(b.status).toBe(HTTP_OK);
    const aBody = adminResponse(a.json);
    const bBody = adminResponse(b.json);

    expect(aBody.agentId).toBe(seedBody.agentId);
    expect(bBody.agentId).toBe(seedBody.agentId);
    expect(aBody.apiKey).not.toBe(bBody.apiKey);
    yield* expectLiveKeyIsOneOf(seedBody.agentId, [aBody.apiKey, bBody.apiKey]);
  });
}

function expectLiveKeyIsOneOf(agentId: string, apiKeys: string[]) {
  return Effect.gen(function* () {
    const liveApiKeyId = yield* selectLiveApiKeyId(agentId);
    const parsedKeyIds = apiKeys.map((apiKey) => parseApiKey(apiKey)?.keyId);
    expect(parsedKeyIds).toContain(liveApiKeyId);
  });
}

function publicRegisterStaysInsertOnly() {
  return Effect.gen(function* () {
    yield* registerAgent(baseUrl, PUBLIC_INSERT_ONLY_AGENT_NAME, {
      inviteCode: REGISTRATION_SECRET,
    });
    const duplicate = yield* Effect.exit(
      registerAgent(baseUrl, PUBLIC_INSERT_ONLY_AGENT_NAME, {
        inviteCode: REGISTRATION_SECRET,
      }),
    );
    expect(Exit.isFailure(duplicate)).toBe(true);
  });
}

describe("/api/v1/admin/register-agent - registration", () => {
  it(
    "registers an agent with explicit ownerUserId when invite code matches",
    registersExplicitOwner,
  );

  it(
    "registers without ownerUserId with null owner_user_id",
    registersWithoutOwner,
  );
});

describe("/api/v1/admin/register-agent - secret validation", () => {
  it("rejects when invite code is missing", rejectsMissingInviteCode);
  it(
    "rejects when invite code does not match registrationSecret",
    rejectsWrongInviteCode,
  );
  it("rejects ownerUserId that is not a UUID", rejectsInvalidOwnerUserId);
});

describe("/api/v1/admin/register-agent - reentrant rotation", () => {
  it(
    "re-register same (name, ownerUserId): same agentId, fresh apiKey, status 200",
    reregistersSameOwner,
  );
  it(
    "old apiKey is rejected by network/connect after re-register",
    rejectsOldApiKeyAfterReregister,
  );
  it(
    "re-register with mismatched ownerUserId returns 409",
    rejectsMismatchedOwnerOnReregister,
  );
});

describe("/api/v1/admin/register-agent - reentrant conflicts", () => {
  it(
    "re-register without ownerUserId on a row that has one returns 409",
    rejectsDroppedOwnerOnReregister,
  );
  it(
    "re-register on a suspended agent returns 409 without re-arming it",
    rejectsSuspendedAgentReregister,
  );
  it(
    "concurrent re-register: both calls succeed, both return same agentId",
    concurrentReregisterReturnsSameAgentId,
  );
});

describe("/auth/register public route regression", () => {
  it(
    "public /auth/register stays insert-only for duplicate names",
    publicRegisterStaysInsertOnly,
  );
});
