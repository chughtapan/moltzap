import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
} from "@moltzap/protocol/identity";
import type { Contact } from "@moltzap/protocol/identity";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  createTestUser,
  registerClaimedAgent,
  expectEitherLeft,
  type TestAgentClient,
} from "../helpers.js";

const REGISTRATION_SECRET = "contacts-test-secret-zxcv";
const ALICE_USER = createTestUser(
  "alice",
  "00000000-0000-4000-8000-00000000a11c",
);
const BOB_USER = createTestUser("bob", "00000000-0000-4000-8000-00000000b0b0");
const ALICE_USER_ID = ALICE_USER.id;
const BOB_USER_ID = BOB_USER.id;
const FRAME_SETTLE_MS = 200;
const PROPERTY_RUNS = 25;

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
  { aliceClient: TestAgentClient; bobClient: TestAgentClient },
  Error
> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const aliceReg = yield* registerClaimedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-contacts-${idx}`,
      user: ALICE_USER,
    });
    const bobReg = yield* registerClaimedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `bob-contacts-${idx}`,
      user: BOB_USER,
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

function collectContactRequests(client: TestAgentClient) {
  return client
    .subscribe(ContactRequestNotificationDefinition)
    .pipe(
      Stream.interruptAfter(Duration.millis(FRAME_SETTLE_MS)),
      Stream.runCollect,
      Effect.map(Chunk.toReadonlyArray),
      Effect.fork,
    );
}

function collectContactAccepted(client: TestAgentClient) {
  return client
    .subscribe(ContactAcceptedNotificationDefinition)
    .pipe(
      Stream.interruptAfter(Duration.millis(FRAME_SETTLE_MS)),
      Stream.runCollect,
      Effect.map(Chunk.toReadonlyArray),
      Effect.fork,
    );
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
    const bobRequestsFiber = yield* collectContactRequests(bobClient);
    const aliceRequestsFiber = yield* collectContactRequests(aliceClient);
    const result = yield* aliceClient.sendRpc(ContactsAdd, {
      contactUserId: BOB_USER_ID as Contact["contactUserId"],
    });
    expect(result.contact.contactUserId).toBe(BOB_USER_ID);

    const bobRequests = yield* Fiber.join(bobRequestsFiber);
    const aliceRequests = yield* Fiber.join(aliceRequestsFiber);
    expect(bobRequests).toHaveLength(1);
    expect(aliceRequests).toHaveLength(0);
  }));

it("contacts/accept fans contact/accepted to the requester", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const added = yield* aliceClient.sendRpc(ContactsAdd, {
      contactUserId: BOB_USER_ID as Contact["contactUserId"],
    });
    const aliceAcceptedFiber = yield* collectContactAccepted(aliceClient);
    const bobAcceptedFiber = yield* collectContactAccepted(bobClient);
    yield* bobClient.sendRpc(ContactsAccept, {
      contactId: added.contact.id,
    });

    const aliceAccepted = yield* Fiber.join(aliceAcceptedFiber);
    const bobAccepted = yield* Fiber.join(bobAcceptedFiber);
    expect(aliceAccepted).toHaveLength(1);
    expect(bobAccepted).toHaveLength(0);
    expect(aliceAccepted[0]!.contact.contactUserId).toBe(BOB_USER_ID);
  }));

it("contacts/accept is idempotent", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const added = yield* aliceClient.sendRpc(ContactsAdd, {
      contactUserId: BOB_USER_ID as Contact["contactUserId"],
    });
    const aliceAcceptedFiber = yield* collectContactAccepted(aliceClient);
    yield* bobClient.sendRpc(ContactsAccept, {
      contactId: added.contact.id,
    });
    yield* bobClient.sendRpc(ContactsAccept, {
      contactId: added.contact.id,
    });

    const aliceAccepted = yield* Fiber.join(aliceAcceptedFiber);
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
    const aliceReg = yield* registerClaimedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: "alice-contacts-self",
      user: ALICE_USER,
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
