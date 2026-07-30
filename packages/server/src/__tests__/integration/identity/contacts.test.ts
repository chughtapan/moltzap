import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  contactAcceptedNotificationDefinition,
  contactRequestNotificationDefinition,
  contactsAccept,
  contactsAdd,
  contactsList,
} from "@moltzap/protocol/identity";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  createTestUser,
  registerOwnedAgent,
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
    const aliceReg = yield* registerOwnedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-contacts-${idx}`,
      user: ALICE_USER,
    });
    const bobReg = yield* registerOwnedAgent({
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
    .subscribe(contactRequestNotificationDefinition)
    .pipe(
      Stream.interruptAfter(Duration.millis(FRAME_SETTLE_MS)),
      Stream.runCollect,
      Effect.map(Chunk.toReadonlyArray),
      Effect.fork,
    );
}

function collectContactAccepted(client: TestAgentClient) {
  return client
    .subscribe(contactAcceptedNotificationDefinition)
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

it("agent/identity/contacts/add fans contact/request to the recipient", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const bobRequestsFiber = yield* collectContactRequests(bobClient);
    const aliceRequestsFiber = yield* collectContactRequests(aliceClient);
    const result = yield* aliceClient.sendRpc(contactsAdd, {
      contactUserId: BOB_USER_ID,
    });
    expect(result.contact.contactUserId).toBe(BOB_USER_ID);

    const bobRequests = yield* Fiber.join(bobRequestsFiber);
    const aliceRequests = yield* Fiber.join(aliceRequestsFiber);
    expect(bobRequests).toHaveLength(1);
    expect(aliceRequests).toHaveLength(0);
  }));

it("agent/identity/contacts/accept fans contact/accepted to the requester", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const added = yield* aliceClient.sendRpc(contactsAdd, {
      contactUserId: BOB_USER_ID,
    });
    const aliceAcceptedFiber = yield* collectContactAccepted(aliceClient);
    const bobAcceptedFiber = yield* collectContactAccepted(bobClient);
    yield* bobClient.sendRpc(contactsAccept, {
      contactId: added.contact.id,
    });

    const aliceAccepted = yield* Fiber.join(aliceAcceptedFiber);
    const bobAccepted = yield* Fiber.join(bobAcceptedFiber);
    expect(aliceAccepted).toHaveLength(1);
    expect(bobAccepted).toHaveLength(0);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ aliceAccepted[0]!
        .contact.contactUserId,
    ).toBe(BOB_USER_ID);
  }));

it("agent/identity/contacts/accept is idempotent", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const added = yield* aliceClient.sendRpc(contactsAdd, {
      contactUserId: BOB_USER_ID,
    });
    const aliceAcceptedFiber = yield* collectContactAccepted(aliceClient);
    yield* bobClient.sendRpc(contactsAccept, {
      contactId: added.contact.id,
    });
    yield* bobClient.sendRpc(contactsAccept, {
      contactId: added.contact.id,
    });

    const aliceAccepted = yield* Fiber.join(aliceAcceptedFiber);
    expect(aliceAccepted).toHaveLength(1);
  }));

it("agent/identity/contacts/list returns both accepted rows", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const added = yield* aliceClient.sendRpc(contactsAdd, {
      contactUserId: BOB_USER_ID,
    });
    yield* bobClient.sendRpc(contactsAccept, {
      contactId: added.contact.id,
    });

    const aliceList = yield* aliceClient.sendRpc(contactsList, {});
    const bobList = yield* bobClient.sendRpc(contactsList, {});
    expect(aliceList.contacts.map((c) => c.contactUserId)).toContain(
      BOB_USER_ID,
    );
    expect(bobList.contacts.map((c) => c.contactUserId)).toContain(
      ALICE_USER_ID,
    );
  }));

it("agent/identity/contacts/add rejects self-add", () =>
  Effect.gen(function* () {
    const aliceReg = yield* registerOwnedAgent({
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
      aliceClient.sendRpc(contactsAdd, {
        contactUserId: ALICE_USER_ID,
      }),
    );
    expect(expectEitherLeft(exit)).toBeDefined();
  }));

function notificationMethodMatches(actual: string, expected: string): boolean {
  return actual === expected;
}
