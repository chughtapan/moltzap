import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  type Contact,
  type NotificationFrame,
} from "@moltzap/protocol";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
  HTTP_CREATED,
  HTTP_OK,
  type ServerTestClient,
} from "../helpers.js";

const REGISTRATION_SECRET = "contacts-test-secret-zxcv";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11c";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b0";
const FRAME_SETTLE_MS = 200;

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

beforeAll(async () => {
  const server = await startTestServer({
    registrationSecret: REGISTRATION_SECRET,
  });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  pairCounter = 0;
});

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

async function adminRegister(
  name: string,
  ownerUserId: string,
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
  if (res.status !== HTTP_CREATED && res.status !== HTTP_OK) {
    throw new Error(
      `admin register failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

function setupAliceAndBob(): Effect.Effect<
  { aliceClient: ServerTestClient; bobClient: ServerTestClient },
  Error
> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const aliceReg = yield* Effect.tryPromise(() =>
      adminRegister(`alice-contacts-${idx}`, ALICE_USER_ID),
    );
    const bobReg = yield* Effect.tryPromise(() =>
      adminRegister(`bob-contacts-${idx}`, BOB_USER_ID),
    );
    const aliceClient = yield* connectTestClient({
      wsUrl,
      agentId: aliceReg.agentId,
      apiKey: aliceReg.apiKey,
    });
    trackClient(aliceClient);
    const bobClient = yield* connectTestClient({
      wsUrl,
      agentId: bobReg.agentId,
      apiKey: bobReg.apiKey,
    });
    trackClient(bobClient);
    return { aliceClient, bobClient };
  });
}

function notificationsByMethod(
  client: { snapshot: Effect.Effect<unknown, never> },
  method: string,
): Effect.Effect<NotificationFrame[], never> {
  return Effect.gen(function* () {
    const snap = (yield* client.snapshot) as ReadonlyArray<{
      kind: string;
      frame: NotificationFrame | null;
    }>;
    return snap
      .filter((s) => s.kind === "inbound" && s.frame !== null)
      .map((s) => s.frame!)
      .filter((f) => "method" in f && f.method === method);
  });
}

describe("Contacts RPC end-to-end", () => {
  it.live("contacts/add fans contact/request to the recipient (Bob)", () =>
    Effect.gen(function* () {
      const { aliceClient, bobClient } = yield* setupAliceAndBob();
      const result = yield* aliceClient.sendRpc(ContactsAdd, {
        contactUserId: BOB_USER_ID as Contact["contactUserId"],
      });
      expect(result.contact.contactUserId).toBe(BOB_USER_ID);
      yield* Effect.sleep(`${FRAME_SETTLE_MS} millis`);

      const bobRequests = yield* notificationsByMethod(
        bobClient,
        "contact/request",
      );
      const aliceRequests = yield* notificationsByMethod(
        aliceClient,
        "contact/request",
      );
      expect(bobRequests).toHaveLength(1);
      expect(aliceRequests).toHaveLength(0);
    }),
  );

  it.live(
    "contacts/accept fans contact/accepted to the REQUESTER (Alice), not the accepter (Bob) — CRIT-1 regression guard",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const added = yield* aliceClient.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID as Contact["contactUserId"],
        });
        yield* bobClient.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });
        yield* Effect.sleep(`${FRAME_SETTLE_MS} millis`);

        const aliceAccepted = yield* notificationsByMethod(
          aliceClient,
          "contact/accepted",
        );
        const bobAccepted = yield* notificationsByMethod(
          bobClient,
          "contact/accepted",
        );
        expect(aliceAccepted).toHaveLength(1);
        expect(bobAccepted).toHaveLength(0);
        const params = aliceAccepted[0]!.params as { contact: Contact };
        expect(params.contact.contactUserId).toBe(BOB_USER_ID);
      }),
  );

  it.live(
    "contacts/accept is idempotent — second accept returns the same contact and fires no extra notification",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const added = yield* aliceClient.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID as Contact["contactUserId"],
        });
        yield* bobClient.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });
        yield* bobClient.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });
        yield* Effect.sleep(`${FRAME_SETTLE_MS} millis`);

        const aliceAccepted = yield* notificationsByMethod(
          aliceClient,
          "contact/accepted",
        );
        expect(aliceAccepted).toHaveLength(1);
      }),
  );

  it.live(
    "contacts/list returns the caller's rows; both sides see the contact after accept",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const added = yield* aliceClient.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID as Contact["contactUserId"],
        });
        yield* bobClient.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });

        const aliceList = yield* aliceClient.sendRpc(ContactsList, {});
        const bobList = yield* bobClient.sendRpc(ContactsList, {});
        expect(aliceList.contacts.map((c) => c.contactUserId)).toContain(
          BOB_USER_ID,
        );
        expect(bobList.contacts.map((c) => c.contactUserId)).toContain(
          ALICE_USER_ID,
        );
      }),
  );

  it.live("contacts/add rejects self-add (Alice → Alice)", () =>
    Effect.gen(function* () {
      const aliceReg = yield* Effect.tryPromise(() =>
        adminRegister("alice-contacts-self", ALICE_USER_ID),
      );
      const aliceClient = yield* connectTestClient({
        wsUrl,
        agentId: aliceReg.agentId,
        apiKey: aliceReg.apiKey,
      });
      trackClient(aliceClient);
      const exit = yield* Effect.either(
        aliceClient.sendRpc(ContactsAdd, {
          contactUserId: ALICE_USER_ID as Contact["contactUserId"],
        }),
      );
      expect(Either.isLeft(exit)).toBe(true);
    }),
  );
});
