/**
 * Integration tests for presence/subscribe contact-policy error (#508).
 *
 * Verifies that the server propagates NotInContactsError over the JSON-RPC
 * wire when a caller requests agentIds outside their contact-visible set.
 * Test 26 covers broadcast lifecycle with a shared owner; this file covers
 * the policy-rejection path with distinct owners and no contact relationship.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
} from "./helpers.js";
import { userId, RpcResponseError } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import { NotInContactsError, PresenceSubscribe } from "@moltzap/protocol";

// Two distinct owners with no contact relationship.
const REGISTRATION_SECRET = "presence-policy-test-secret-gh508";
const ALICE_USER_ID = userId("00000000-0000-4000-8000-00000000a5a5") as UserId;
const CAROL_USER_ID = userId("00000000-0000-4000-8000-00000000c5c5") as UserId;

let baseUrl: string;
let wsUrl: string;
let agentCounter = 0;

beforeAll(async () => {
  const server = await startTestServer({
    registrationSecret: REGISTRATION_SECRET,
  });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  agentCounter = 0;
});

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

async function adminRegister(
  name: string,
  ownerUserId: UserId,
): Promise<AdminRegisterResponse> {
  const res = await fetch(`${baseUrl}/api/v1/admin/register-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      inviteCode: REGISTRATION_SECRET,
      ownerUserId,
    }),
  });
  const json = (await res.json()) as AdminRegisterResponse;
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `admin register failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

function registerAndConnectOwned(opts: { name: string; ownerUserId: UserId }) {
  return Effect.gen(function* () {
    const idx = ++agentCounter;
    const reg = yield* Effect.tryPromise(() =>
      adminRegister(`${opts.name}-${idx}`, opts.ownerUserId),
    );
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return { agentId: reg.agentId, client };
  });
}

/** Extract the `RpcResponseError` from an exit's failure cause, or throw. */
function extractRpcResponseError(
  exit: Exit.Exit<unknown, unknown>,
): RpcResponseError {
  expect(Exit.isFailure(exit)).toBe(true);
  const failureOpt = Cause.failureOption(
    (exit as Exit.Failure<unknown, unknown>).cause,
  );
  expect(failureOpt._tag).toBe("Some");
  const err = (failureOpt as { _tag: "Some"; value: unknown }).value;
  expect(err).toBeInstanceOf(RpcResponseError);
  return err as RpcResponseError;
}

describe("presence/subscribe — NotInContactsError wire propagation (#508)", () => {
  it.live(
    "returns NotInContactsError when subscribing to an agentId outside the caller's contact-visible set",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-pol",
          ownerUserId: ALICE_USER_ID,
        });
        const carol = yield* registerAndConnectOwned({
          name: "carol-pol",
          ownerUserId: CAROL_USER_ID,
        });
        // alice and carol have distinct owners and no contact relationship.

        const exit = yield* Effect.exit(
          alice.client.sendRpc(PresenceSubscribe, {
            agentIds: [carol.agentId],
          }),
        );

        const err = extractRpcResponseError(exit);
        expect(err.code).toBe(NotInContactsError.code);
        const data = err.data as { agentIds: string[] } | undefined;
        expect(data?.agentIds).toContain(carol.agentId);
      }),
  );

  it.live(
    "returns NotInContactsError listing only the rejected subset when some IDs are visible",
    () =>
      Effect.gen(function* () {
        // alice and alice2 share an owner → siblings, mutually visible.
        const alice = yield* registerAndConnectOwned({
          name: "alice-mix",
          ownerUserId: ALICE_USER_ID,
        });
        const alice2 = yield* registerAndConnectOwned({
          name: "alice-mix2",
          ownerUserId: ALICE_USER_ID,
        });
        const carol = yield* registerAndConnectOwned({
          name: "carol-mix",
          ownerUserId: CAROL_USER_ID,
        });

        // alice subscribes to [alice2 (visible sibling), carol (not visible)]
        const exit = yield* Effect.exit(
          alice.client.sendRpc(PresenceSubscribe, {
            agentIds: [alice2.agentId, carol.agentId],
          }),
        );

        const err = extractRpcResponseError(exit);
        expect(err.code).toBe(NotInContactsError.code);
        const data = err.data as { agentIds: string[] } | undefined;
        // Only carol is rejected; alice2 (sibling) is visible.
        expect(data?.agentIds).toContain(carol.agentId);
        expect(data?.agentIds).not.toContain(alice2.agentId);
      }),
  );
});
