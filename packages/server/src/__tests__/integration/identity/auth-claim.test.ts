import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect, Exit } from "effect";
import { ContactsAdd } from "@moltzap/protocol";
import { userId } from "@moltzap/protocol/testing";
import {
  CLAIM_NOT_FOUND,
  CLAIM_OWNER_MISMATCH,
} from "../../../identity/services/auth.service.js";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  postJson,
  trackClient,
  connectTestClient,
  registerAgent,
  HTTP_BAD_REQUEST,
  HTTP_CREATED,
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
} from "../helpers.js";

const it = effectIt.live;

const REGISTRATION_SECRET = "claim-test-secret-zxcv";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11c";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b0";
const UNKNOWN_CLAIM_TOKEN = "MZAP-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
const MALFORMED_CLAIM_TOKEN = "MZAP-XYZ";
const INVALID_OWNER_USER_ID = "not-a-uuid";
const WRONG_INVITE_CODE = "wrong-secret";
const CLAIM_URL_PATTERN = /\/api\/v1\/auth\/claim$/;

let baseUrl: string;
let wsUrl: string;
let counter = 0;

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

beforeEach(() =>
  Effect.runPromise(
    resetTestDbEffect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          counter = 0;
        }),
      ),
    ),
  ),
);

interface ClaimResponse {
  agentId: string;
  ownerUserId: string;
}

interface ClaimError {
  error: string;
  code?: string;
}

type RegisteredAgent =
  ReturnType<typeof registerAgent> extends Effect.Effect<infer A, infer _E>
    ? A
    : never;

type ConnectedTestClient =
  ReturnType<typeof connectTestClient> extends Effect.Effect<infer A, infer _E>
    ? A
    : never;

function postClaim(body: Record<string, unknown>) {
  return postJson(baseUrl, "/api/v1/auth/claim", body);
}

function registerClaimAgent(namePrefix: string) {
  const idx = ++counter;
  return registerAgent(baseUrl, `${namePrefix}-${idx}`, {
    inviteCode: REGISTRATION_SECRET,
  });
}

function claimAgent(
  registration: RegisteredAgent,
  ownerUserId: string,
  inviteCode = REGISTRATION_SECRET,
) {
  return postClaim({
    claimToken: registration.claimToken,
    ownerUserId,
    inviteCode,
  });
}

function claimResponse(json: unknown) {
  return json as ClaimResponse;
}

function claimError(json: unknown) {
  return json as ClaimError;
}

function connectRegisteredAgent(registration: RegisteredAgent) {
  return Effect.gen(function* () {
    const client = yield* connectTestClient({
      wsUrl,
      agentId: registration.agentId,
      apiKey: registration.apiKey,
    });
    trackClient(client);
    return client;
  });
}

function expectContactsAddSucceeds(
  client: ConnectedTestClient,
  contactUserId: string,
) {
  return Effect.gen(function* () {
    const result = yield* client.sendRpc(ContactsAdd, {
      contactUserId: userId(contactUserId),
    });
    expect(contactUserIdFromResult(result)).toBe(contactUserId);
  });
}

function expectContactsAddFails(
  client: ConnectedTestClient,
  contactUserId: string,
) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      client.sendRpc(ContactsAdd, { contactUserId: userId(contactUserId) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
}

function contactUserIdFromResult(result: unknown) {
  return (result as { contact: { contactUserId: string } }).contact
    .contactUserId;
}

function registerClaimAndAddContact() {
  return Effect.gen(function* () {
    const aliceReg = yield* registerClaimAgent("alice-claim");
    const bobReg = yield* registerClaimAgent("bob-claim");
    expect(aliceReg.claimToken).toBeDefined();
    expect(bobReg.claimToken).toBeDefined();
    expect(aliceReg.claimUrl).toMatch(CLAIM_URL_PATTERN);

    const aliceClaim = yield* claimAgent(aliceReg, ALICE_USER_ID);
    expect(aliceClaim.status).toBe(HTTP_CREATED);
    const aliceClaimBody = claimResponse(aliceClaim.json);
    expect(aliceClaimBody.agentId).toBe(aliceReg.agentId);
    expect(aliceClaimBody.ownerUserId).toBe(ALICE_USER_ID);

    yield* claimAgent(bobReg, BOB_USER_ID);
    const aliceClient = yield* connectRegisteredAgent(aliceReg);
    yield* expectContactsAddSucceeds(aliceClient, BOB_USER_ID);
  });
}

function idempotentReclaimReturnsOk() {
  return Effect.gen(function* () {
    const reg = yield* registerClaimAgent("idem-claim");
    const first = yield* claimAgent(reg, ALICE_USER_ID);
    expect(first.status).toBe(HTTP_CREATED);

    const second = yield* claimAgent(reg, ALICE_USER_ID);
    expect(second.status).toBe(HTTP_OK);
  });
}

function originalConnectionUsesClaimedOwner() {
  return Effect.gen(function* () {
    const aliceReg = yield* registerClaimAgent("alice-conn-claim");
    const bobReg = yield* registerClaimAgent("bob-conn-claim");
    yield* claimAgent(bobReg, BOB_USER_ID);

    const aliceClient = yield* connectRegisteredAgent(aliceReg);
    yield* expectContactsAddFails(aliceClient, BOB_USER_ID);

    const aliceClaim = yield* claimAgent(aliceReg, ALICE_USER_ID);
    expect(aliceClaim.status).toBe(HTTP_CREATED);

    yield* expectContactsAddSucceeds(aliceClient, BOB_USER_ID);
  });
}

function ownerMismatchReturnsForbidden() {
  return Effect.gen(function* () {
    const reg = yield* registerClaimAgent("mismatch-claim");
    yield* claimAgent(reg, ALICE_USER_ID);
    const conflict = yield* claimAgent(reg, BOB_USER_ID);

    expect(conflict.status).toBe(HTTP_FORBIDDEN);
    expect(claimError(conflict.json).code).toBe(CLAIM_OWNER_MISMATCH);
  });
}

function unknownClaimTokenReturnsUnauthorized() {
  return Effect.gen(function* () {
    const result = yield* postClaim({
      claimToken: UNKNOWN_CLAIM_TOKEN,
      ownerUserId: ALICE_USER_ID,
      inviteCode: REGISTRATION_SECRET,
    });
    expect(result.status).toBe(HTTP_UNAUTHORIZED);
    expect(claimError(result.json).code).toBe(CLAIM_NOT_FOUND);
  });
}

function rejectsMissingOwnerUserId() {
  return Effect.gen(function* () {
    const result = yield* postClaim({
      claimToken: MALFORMED_CLAIM_TOKEN,
      inviteCode: REGISTRATION_SECRET,
    });
    expect(result.status).toBe(HTTP_BAD_REQUEST);
  });
}

function rejectsNonUuidOwnerUserId() {
  return Effect.gen(function* () {
    const result = yield* postClaim({
      claimToken: MALFORMED_CLAIM_TOKEN,
      ownerUserId: INVALID_OWNER_USER_ID,
      inviteCode: REGISTRATION_SECRET,
    });
    expect(result.status).toBe(HTTP_BAD_REQUEST);
  });
}

function wrongInviteCodeIsForbidden() {
  return Effect.gen(function* () {
    const reg = yield* registerClaimAgent("bad-invite");
    const result = yield* claimAgent(reg, ALICE_USER_ID, WRONG_INVITE_CODE);
    expect(result.status).toBe(HTTP_FORBIDDEN);
  });
}

function missingInviteCodeIsForbidden() {
  return Effect.gen(function* () {
    const reg = yield* registerClaimAgent("missing-invite");
    const result = yield* postClaim({
      claimToken: reg.claimToken,
      ownerUserId: ALICE_USER_ID,
    });
    expect(result.status).toBe(HTTP_FORBIDDEN);
  });
}

function contactsAddFailsBeforeClaim() {
  return Effect.gen(function* () {
    const reg = yield* registerClaimAgent("pre-claim");
    const client = yield* connectRegisteredAgent(reg);
    yield* expectContactsAddFails(client, BOB_USER_ID);
  });
}

describe("/api/v1/auth/claim - happy path", () => {
  it(
    "end-to-end: register then claim then contacts/add succeeds",
    registerClaimAndAddContact,
  );
  it("idempotent re-claim returns 200", idempotentReclaimReturnsOk);
  it(
    "connect then out-of-band claim updates the original connection",
    originalConnectionUsesClaimedOwner,
  );
});

describe("/api/v1/auth/claim - claim errors", () => {
  it(
    "owner-mismatch returns 403 with CLAIM_OWNER_MISMATCH code",
    ownerMismatchReturnsForbidden,
  );
  it(
    "unknown claim token returns 401 with CLAIM_NOT_FOUND code",
    unknownClaimTokenReturnsUnauthorized,
  );
});

describe("/api/v1/auth/claim - request validation", () => {
  it(
    "validator rejects malformed body missing ownerUserId",
    rejectsMissingOwnerUserId,
  );
  it("validator rejects non-UUID ownerUserId", rejectsNonUuidOwnerUserId);
});

describe("/api/v1/auth/claim - inviteCode gate", () => {
  it("wrong inviteCode returns 403", wrongInviteCodeIsForbidden);
  it("missing inviteCode returns 403", missingInviteCodeIsForbidden);
});

describe("/api/v1/auth/claim - owner-gated RPC regression", () => {
  it("contacts/add fails before claim", contactsAddFailsBeforeClaim);
});
