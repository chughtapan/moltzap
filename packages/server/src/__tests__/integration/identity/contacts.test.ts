import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  type Contact,
  type NotificationFrame,
} from "@moltzap/protocol";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  adminRegisterAgent,
  expectEitherLeft,
  type ServerTestClient,
} from "../helpers.js";

const REGISTRATION_SECRET = "contacts-test-secret-zxcv";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11c";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b0";
const FRAME_SETTLE_MS = 200;
const PROPERTY_RUNS = 25;
const CONTACT_REQUEST_METHOD = "contact/request";
const CONTACT_ACCEPTED_METHOD = "contact/accepted";

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect({
        registrationSecret: REGISTRATION_SECRET,
      });
      baseUrl = server.baseUrl;
      wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* resetTestDbEffect();
      pairCounter = 0;
    }),
  ),
);

function setupAliceAndBob(): Effect.Effect<
  { aliceClient: ServerTestClient; bobClient: ServerTestClient },
  Error
> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const aliceReg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-contacts-${idx}`,
      ownerUserId: ALICE_USER_ID,
    });
    const bobReg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `bob-contacts-${idx}`,
      ownerUserId: BOB_USER_ID,
    });
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

it("property: notification method matcher is exact", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.string(), fc.string(), (actual, expected) => {
        expect(notificationMethodMatches(actual, expected)).toBe(
          actual === expected,
        );
      }),
      { numRuns: PROPERTY_RUNS },
    );
  }));

it("contacts/add fans contact/request to the recipient", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const result = yield* aliceClient.sendRpc(ContactsAdd, {
      contactUserId: BOB_USER_ID as Contact["contactUserId"],
    });
    expect(result.contact.contactUserId).toBe(BOB_USER_ID);
    yield* Effect.sleep(`${FRAME_SETTLE_MS} millis`);

    const bobRequests = yield* notificationsByMethod(
      bobClient,
      CONTACT_REQUEST_METHOD,
    );
    const aliceRequests = yield* notificationsByMethod(
      aliceClient,
      CONTACT_REQUEST_METHOD,
    );
    expect(bobRequests).toHaveLength(1);
    expect(aliceRequests).toHaveLength(0);
  }));

it("contacts/accept fans contact/accepted to the requester", () =>
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
      CONTACT_ACCEPTED_METHOD,
    );
    const bobAccepted = yield* notificationsByMethod(
      bobClient,
      CONTACT_ACCEPTED_METHOD,
    );
    expect(aliceAccepted).toHaveLength(1);
    expect(bobAccepted).toHaveLength(0);
    const params = aliceAccepted[0]!.params as { contact: Contact };
    expect(params.contact.contactUserId).toBe(BOB_USER_ID);
  }));

it("contacts/accept is idempotent", () =>
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
      CONTACT_ACCEPTED_METHOD,
    );
    expect(aliceAccepted).toHaveLength(1);
  }));

it("contacts/list returns both accepted rows", () =>
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
  }));

it("contacts/add rejects self-add", () =>
  Effect.gen(function* () {
    const aliceReg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: "alice-contacts-self",
      ownerUserId: ALICE_USER_ID,
    });
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
    expect(expectEitherLeft(exit)).toBeDefined();
  }));

function notificationMethodMatches(actual: string, expected: string): boolean {
  return actual === expected;
}
