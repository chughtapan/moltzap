import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { ContactsAdd } from "@moltzap/protocol";
import {
  CLAIM_NOT_FOUND,
  CLAIM_OWNER_MISMATCH,
} from "../../services/auth.service.js";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  postJson,
  trackClient,
  connectTestClient,
  registerAgent,
} from "./helpers.js";

const REGISTRATION_SECRET = "claim-test-secret-zxcv";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11c";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b0";

let baseUrl: string;
let wsUrl: string;
let counter = 0;

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
  counter = 0;
});

interface ClaimResponse {
  agentId: string;
  ownerUserId: string;
}

interface ClaimError {
  error: string;
  code?: string;
}

const postClaim = (body: Record<string, unknown>) =>
  postJson(baseUrl, "/api/v1/auth/claim", body);

describe("/api/v1/auth/claim — programmatic claim (#486)", () => {
  // The 3 happy/conflict/not-found service-level cases are covered by
  // `services/auth.service.test.ts`. The integration tests below exercise
  // only what the unit tests can't: HTTP wire envelope (status codes,
  // claimUrl/claimToken from `auth/register`), inviteCode gating, and
  // the post-claim contacts/add round-trip that proves the whole
  // register→claim→ownerUserId-set flow unblocks owner-gated RPCs.

  it.live("end-to-end: register → claim → contacts/add succeeds", () =>
    Effect.gen(function* () {
      const idx = ++counter;
      const aliceReg = yield* registerAgent(baseUrl, `alice-claim-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      const bobReg = yield* registerAgent(baseUrl, `bob-claim-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      // Phase 1 of #486: register now actually returns claimToken (the
      // pre-#486 server diverged from the protocol Register.result schema
      // by omitting it because nothing consumed it).
      expect(aliceReg.claimToken).toBeDefined();
      expect(bobReg.claimToken).toBeDefined();
      expect(aliceReg.claimUrl).toMatch(/\/api\/v1\/auth\/claim$/);

      const aliceClaim = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: aliceReg.claimToken,
          ownerUserId: ALICE_USER_ID,
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      expect(aliceClaim.status).toBe(201);
      const aliceClaimBody = aliceClaim.json as ClaimResponse;
      expect(aliceClaimBody.agentId).toBe(aliceReg.agentId);
      expect(aliceClaimBody.ownerUserId).toBe(ALICE_USER_ID);

      yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: bobReg.claimToken,
          ownerUserId: BOB_USER_ID,
          inviteCode: REGISTRATION_SECRET,
        }),
      );

      const aliceClient = yield* connectTestClient({
        wsUrl,
        agentId: aliceReg.agentId,
        apiKey: aliceReg.apiKey,
      });
      trackClient(aliceClient);

      const result = yield* aliceClient.sendRpc(ContactsAdd, {
        contactUserId: BOB_USER_ID,
      });
      // ContactsAdd.result is `{ contact: ContactSchema }` — proves
      // requireOwner did not fail (i.e., the claim populated owner_user_id
      // and network/connect picked it up).
      expect(
        (result as { contact: { contactUserId: string } }).contact
          .contactUserId,
      ).toBe(BOB_USER_ID);
    }),
  );

  it.live(
    "idempotent re-claim returns 200 (HTTP status reflects no state change)",
    () =>
      Effect.gen(function* () {
        const idx = ++counter;
        const reg = yield* registerAgent(baseUrl, `idem-claim-${idx}`, {
          inviteCode: REGISTRATION_SECRET,
        });

        const first = yield* Effect.tryPromise(() =>
          postClaim({
            claimToken: reg.claimToken,
            ownerUserId: ALICE_USER_ID,
            inviteCode: REGISTRATION_SECRET,
          }),
        );
        expect(first.status).toBe(201);

        const second = yield* Effect.tryPromise(() =>
          postClaim({
            claimToken: reg.claimToken,
            ownerUserId: ALICE_USER_ID,
            inviteCode: REGISTRATION_SECRET,
          }),
        );
        expect(second.status).toBe(200);
      }),
  );

  it.live("owner-mismatch returns 403 with CLAIM_OWNER_MISMATCH code", () =>
    Effect.gen(function* () {
      const idx = ++counter;
      const reg = yield* registerAgent(baseUrl, `mismatch-claim-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: reg.claimToken,
          ownerUserId: ALICE_USER_ID,
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      const conflict = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: reg.claimToken,
          ownerUserId: BOB_USER_ID,
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      expect(conflict.status).toBe(403);
      expect((conflict.json as ClaimError).code).toBe(CLAIM_OWNER_MISMATCH);
    }),
  );

  it.live("unknown claim token returns 401 with CLAIM_NOT_FOUND code", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: "MZAP-DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
          ownerUserId: ALICE_USER_ID,
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      expect(result.status).toBe(401);
      expect((result.json as ClaimError).code).toBe(CLAIM_NOT_FOUND);
    }),
  );

  it.live("validator rejects malformed body (missing ownerUserId → 400)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: "MZAP-XYZ",
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      expect(result.status).toBe(400);
    }),
  );

  it.live("validator rejects non-UUID ownerUserId (400)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: "MZAP-XYZ",
          ownerUserId: "not-a-uuid",
          inviteCode: REGISTRATION_SECRET,
        }),
      );
      expect(result.status).toBe(400);
    }),
  );

  it.live("inviteCode gating: wrong code → 403", () =>
    Effect.gen(function* () {
      const idx = ++counter;
      const reg = yield* registerAgent(baseUrl, `bad-invite-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      const result = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: reg.claimToken,
          ownerUserId: ALICE_USER_ID,
          inviteCode: "wrong-secret",
        }),
      );
      expect(result.status).toBe(403);
    }),
  );

  it.live("inviteCode gating: missing code → 403", () =>
    Effect.gen(function* () {
      const idx = ++counter;
      const reg = yield* registerAgent(baseUrl, `missing-invite-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      const result = yield* Effect.tryPromise(() =>
        postClaim({
          claimToken: reg.claimToken,
          ownerUserId: ALICE_USER_ID,
        }),
      );
      expect(result.status).toBe(403);
    }),
  );

  it.live("regression guard: contacts/add fails before claim", () =>
    Effect.gen(function* () {
      const idx = ++counter;
      const reg = yield* registerAgent(baseUrl, `pre-claim-${idx}`, {
        inviteCode: REGISTRATION_SECRET,
      });
      const client = yield* connectTestClient({
        wsUrl,
        agentId: reg.agentId,
        apiKey: reg.apiKey,
      });
      trackClient(client);
      // contacts/add fails with ERR_NEED_OWNER on an unclaimed agent;
      // proves the AC trio is load-bearing (without claim, the flow
      // explicitly does not work).
      const exit = yield* Effect.exit(
        client.sendRpc(ContactsAdd, { contactUserId: BOB_USER_ID }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  // #495 regression: pre-existing connection's `conn.auth.ownerUserId`
  // must refresh after an out-of-band `auth/claim` succeeds. Pre-fix the
  // claim DB-mutation atomic-updated `agents.owner_user_id` but the
  // existing socket's snapshot stayed `null`, so the recommended-order
  // test above (`register → claim → connect`) passed while the
  // connect-then-claim flow silently failed with `ERR_NEED_OWNER` until
  // disconnect+reconnect. The HTTP claim route now patches every live
  // connection of the just-claimed agent (`server.ts` claimRoute on
  // CLAIM_SUCCESS), so subsequent owner-gated RPCs on the original
  // socket succeed.
  it.live(
    "connect → out-of-band claim → contacts/add on original connection succeeds (#495)",
    () =>
      Effect.gen(function* () {
        const idx = ++counter;
        const aliceReg = yield* registerAgent(
          baseUrl,
          `alice-conn-claim-${idx}`,
          { inviteCode: REGISTRATION_SECRET },
        );
        const bobReg = yield* registerAgent(baseUrl, `bob-conn-claim-${idx}`, {
          inviteCode: REGISTRATION_SECRET,
        });

        // Bob is claimed up-front so the `contactUserId` on the
        // contacts/add call below resolves to a real owner. Alice is
        // intentionally NOT yet claimed — we connect first, claim
        // second, to exercise the bug.
        yield* Effect.tryPromise(() =>
          postClaim({
            claimToken: bobReg.claimToken,
            ownerUserId: BOB_USER_ID,
            inviteCode: REGISTRATION_SECRET,
          }),
        );

        // Step 1: alice connects with apiKey BEFORE claiming. At this
        // point `conn.auth.ownerUserId === null`.
        const aliceClient = yield* connectTestClient({
          wsUrl,
          agentId: aliceReg.agentId,
          apiKey: aliceReg.apiKey,
        });
        trackClient(aliceClient);

        // Sanity: contacts/add fails right now because alice is unclaimed.
        const preClaimExit = yield* Effect.exit(
          aliceClient.sendRpc(ContactsAdd, { contactUserId: BOB_USER_ID }),
        );
        expect(Exit.isFailure(preClaimExit)).toBe(true);

        // Step 2: out-of-band claim via HTTP (separate connection — the
        // claim route is HTTP, not over the WS).
        const aliceClaim = yield* Effect.tryPromise(() =>
          postClaim({
            claimToken: aliceReg.claimToken,
            ownerUserId: ALICE_USER_ID,
            inviteCode: REGISTRATION_SECRET,
          }),
        );
        expect(aliceClaim.status).toBe(201);

        // Step 3: subsequent contacts/add on the ORIGINAL connection
        // must now succeed. This is the regression: pre-fix it failed
        // with ERR_NEED_OWNER because conn.auth.ownerUserId was still
        // null.
        const result = yield* aliceClient.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID,
        });
        expect(
          (result as { contact: { contactUserId: string } }).contact
            .contactUserId,
        ).toBe(BOB_USER_ID);
      }),
  );
});
