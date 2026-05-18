import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  getKyselyDb,
  trackClient,
  connectTestClient,
  adminRegisterAgent,
} from "../helpers.js";
import type { AgentCard } from "@moltzap/protocol";
import { userId } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";

import {
  AgentsList,
  AgentsLookup,
  AgentsLookupByName,
  ContactsAdd,
  ContactsAccept,
} from "@moltzap/protocol";

const it = effectIt.live;

type AgentsListResult = { agents: Record<string, AgentCard> };
type AgentsArrayResult = { agents: AgentCard[] };

// agents/list is contact-scoped per #481; admin-register is used to bind
// explicit owners so the cross-owner visibility cases can be exercised.
const REGISTRATION_SECRET = "agents-list-test-secret-zxcv";
const ALICE_USER_ID = userId("00000000-0000-4000-8000-00000000a11c");
const BOB_USER_ID = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL_USER_ID = userId("00000000-0000-4000-8000-00000000ca60");
const AGENT_DESCRIPTION = "A test agent";
const LOOKUP_DESCRIPTION = "Has a description";
const AGENT_STATUS_ACTIVE = "active";
const AGENT_STATUS_SUSPENDED = "suspended";
const UNKNOWN_AGENT_ID = "00000000-0000-0000-0000-000000000000";
const UNKNOWN_AGENT_NAME = "nonexistent";

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

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
          pairCounter = 0;
        }),
      ),
    ),
  ),
);

function adminRegister(
  name: string,
  ownerUserId: UserId,
  description?: string,
) {
  return adminRegisterAgent({
    baseUrl,
    inviteCode: REGISTRATION_SECRET,
    name,
    ownerUserId,
    description,
  });
}

interface OwnedConnectedAgent {
  agentId: string;
  ownerUserId: UserId;
  client: Awaited<
    ReturnType<typeof connectTestClient> extends Effect.Effect<
      infer A,
      infer _E
    >
      ? A
      : never
  >;
}

function registerAndConnectOwned(opts: {
  name: string;
  ownerUserId: UserId;
  description?: string;
}) {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const reg = yield* adminRegister(
      `${opts.name}-${idx}`,
      opts.ownerUserId,
      opts.description,
    );
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return {
      agentId: reg.agentId,
      ownerUserId: opts.ownerUserId,
      client,
    };
  });
}

function connectAlice(name: string, description?: string) {
  return registerAndConnectOwned({
    name,
    ownerUserId: ALICE_USER_ID,
    description,
  });
}

function connectBob(name: string, description?: string) {
  return registerAndConnectOwned({
    name,
    ownerUserId: BOB_USER_ID,
    description,
  });
}

function connectCarol(name: string, description?: string) {
  return registerAndConnectOwned({
    name,
    ownerUserId: CAROL_USER_ID,
    description,
  });
}

function listAgents(agent: OwnedConnectedAgent) {
  return agent.client.sendRpc(
    AgentsList,
    {},
  ) as Effect.Effect<AgentsListResult>;
}

function lookupAgents(agent: OwnedConnectedAgent, agentIds: string[]) {
  return agent.client.sendRpc(AgentsLookup, {
    agentIds,
  }) as Effect.Effect<AgentsArrayResult>;
}

function lookupAgentsByName(agent: OwnedConnectedAgent, names: string[]) {
  return agent.client.sendRpc(AgentsLookupByName, {
    names,
  }) as Effect.Effect<AgentsArrayResult>;
}

function acceptContact(
  requester: OwnedConnectedAgent,
  accepter: OwnedConnectedAgent,
  contactUserId: UserId,
) {
  return Effect.gen(function* () {
    const added = yield* requester.client.sendRpc(ContactsAdd, {
      contactUserId,
    });
    yield* accepter.client.sendRpc(ContactsAccept, {
      contactId: added.contact.id,
    });
  });
}

function persistedAgentName(agentId: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("agents")
      .select("name")
      .where("id", "=", agentId)
      .executeTakeFirstOrThrow(),
  ).pipe(Effect.map((row) => row.name));
}

function suspendAgent(agentId: string) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .updateTable("agents")
      .set({ status: AGENT_STATUS_SUSPENDED })
      .where("id", "=", agentId)
      .execute(),
  ).pipe(Effect.asVoid);
}

function agentIds(result: AgentsListResult) {
  return Object.keys(result.agents);
}

function expectListIncludes(
  result: AgentsListResult,
  expectedAgentIds: string[],
) {
  const ids = agentIds(result);
  for (const agentId of expectedAgentIds) {
    expect(ids).toContain(agentId);
  }
}

function expectListExcludes(
  result: AgentsListResult,
  excludedAgentIds: string[],
) {
  const ids = agentIds(result);
  for (const agentId of excludedAgentIds) {
    expect(ids).not.toContain(agentId);
  }
}

function expectListHasNoCard(result: AgentsListResult, agentId: string) {
  expect(result.agents[agentId]).toBeUndefined();
}

function returnsOwnAgents() {
  return Effect.gen(function* () {
    const alice1 = yield* connectAlice("alice-sib1");
    const alice2 = yield* connectAlice("alice-sib2");

    const result = yield* listAgents(alice1);
    expectListIncludes(result, [alice1.agentId, alice2.agentId]);
  });
}

function hidesOwnersWithoutContact() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-iso");
    const carol = yield* connectCarol("carol-iso");

    const result = yield* listAgents(alice);
    expectListHasNoCard(result, carol.agentId);
    expect(result.agents[alice.agentId]).toBeDefined();
  });
}

function returnsAcceptedContactOwners() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-x");
    const bob = yield* connectBob("bob-x");
    const carol = yield* connectCarol("carol-x");

    yield* acceptContact(alice, bob, BOB_USER_ID);

    const aliceList = yield* listAgents(alice);
    expectListIncludes(aliceList, [alice.agentId, bob.agentId]);
    expectListExcludes(aliceList, [carol.agentId]);

    const bobList = yield* listAgents(bob);
    expectListIncludes(bobList, [bob.agentId, alice.agentId]);
    expectListExcludes(bobList, [carol.agentId]);
  });
}

function pendingContactDoesNotExposeAgents() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-pending");
    const bob = yield* connectBob("bob-pending");

    yield* alice.client.sendRpc(ContactsAdd, {
      contactUserId: BOB_USER_ID,
    });

    const aliceList = yield* listAgents(alice);
    const bobList = yield* listAgents(bob);
    expectListHasNoCard(aliceList, bob.agentId);
    expectListHasNoCard(bobList, alice.agentId);
  });
}

function returnsContactVisibleCardFields() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-card");
    const bob = yield* connectBob("bob-card", AGENT_DESCRIPTION);
    yield* acceptContact(alice, bob, BOB_USER_ID);

    const result = yield* listAgents(alice);
    const card = result.agents[bob.agentId];
    expect(card).toBeDefined();
    expect(card!.id).toBe(bob.agentId);
    expect(card!.description).toBe(AGENT_DESCRIPTION);
    expect(card!.status).toBe(AGENT_STATUS_ACTIVE);
    expect(card!.ownerUserId).toBe(BOB_USER_ID);
  });
}

function looksUpAgentById() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lookup");
    const result = yield* lookupAgents(alice, [alice.agentId]);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.id).toBe(alice.agentId);
    expect(result.agents[0]!.status).toBe(AGENT_STATUS_ACTIVE);
  });
}

function returnsEmptyForUnknownIds() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lookup-empty");
    const result = yield* lookupAgents(alice, [UNKNOWN_AGENT_ID]);

    expect(result.agents).toHaveLength(0);
  });
}

function includesDescriptionInLookupResults() {
  return Effect.gen(function* () {
    const described = yield* connectAlice("desc-agent", LOOKUP_DESCRIPTION);
    const result = yield* lookupAgents(described, [described.agentId]);

    expect(result.agents[0]!.description).toBe(LOOKUP_DESCRIPTION);
  });
}

function returnsCrossOwnerCardsWithoutContact() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lookup-xowner");
    const carol = yield* connectCarol("carol-lookup-xowner");

    const result = yield* lookupAgents(alice, [carol.agentId]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.id).toBe(carol.agentId);
  });
}

function looksUpAgentByName() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lbyn");
    const aliceName = yield* persistedAgentName(alice.agentId);

    const result = yield* lookupAgentsByName(alice, [aliceName]);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.id).toBe(alice.agentId);
  });
}

function onlyReturnsActiveAgentsByName() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-active");
    const aliceName = yield* persistedAgentName(alice.agentId);
    yield* suspendAgent(alice.agentId);

    const bob = yield* connectBob("bob-active");
    yield* acceptContact(bob, alice, ALICE_USER_ID);

    const result = yield* lookupAgentsByName(bob, [aliceName]);

    expect(result.agents).toHaveLength(0);
  });
}

function returnsEmptyForUnknownNames() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-unknown");

    const result = yield* lookupAgentsByName(alice, [UNKNOWN_AGENT_NAME]);

    expect(result.agents).toHaveLength(0);
  });
}

function dropsCrossOwnerNameWithoutContact() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lbyn-iso");
    const carol = yield* connectCarol("carol-lbyn-iso");
    const carolName = yield* persistedAgentName(carol.agentId);

    const result = yield* lookupAgentsByName(alice, [carolName]);
    expect(result.agents).toHaveLength(0);
  });
}

function returnsAcceptedContactCardByName() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-lbyn-c");
    const bob = yield* connectBob("bob-lbyn-c");
    yield* acceptContact(alice, bob, BOB_USER_ID);
    const bobName = yield* persistedAgentName(bob.agentId);

    const result = yield* lookupAgentsByName(alice, [bobName]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.id).toBe(bob.agentId);
  });
}

describe(`${AgentsList.name} — owner visibility per #481`, () => {
  it(
    "returns own agents (siblings under same ownerUserId), without contacts setup",
    returnsOwnAgents,
  );

  it(
    "does NOT return agents owned by users the caller is not in contact with",
    hidesOwnersWithoutContact,
  );

  it(
    "returns agents whose owner is an accepted contact of the caller's owner",
    returnsAcceptedContactOwners,
  );
});

describe(`${AgentsList.name} — contact metadata per #481`, () => {
  it(
    "pending contact request does NOT yet expose the requester's agents to the recipient (and vice versa)",
    pendingContactDoesNotExposeAgents,
  );

  it(
    "returns the AgentCard fields correctly for contact-visible agents",
    returnsContactVisibleCardFields,
  );
});

describe(`${AgentsLookup.name} — NOT contact-scoped per #481`, () => {
  it("returns agent cards by ID", looksUpAgentById);
  it("returns empty array for unknown IDs", returnsEmptyForUnknownIds);
  it(
    "includes description in lookup results",
    includesDescriptionInLookupResults,
  );
});

describe(`${AgentsLookup.name} — cross-owner dereference per #481`, () => {
  // Per architect #481: dereference-by-known-key. The client uses this RPC to
  // resolve peer `AgentCard`s for UI rendering of conversation messages
  // (`packages/client/src/service.ts:resolveAgentName` and the bulk-history
  // lookup); contact-scoping it would render conversation peers as UUIDs.
  it(
    "returns cross-owner cards regardless of contact relationship",
    returnsCrossOwnerCardsWithoutContact,
  );
});

describe(`${AgentsLookupByName.name} — contact-scoped per #481/#506`, () => {
  it("returns agent cards by name", looksUpAgentByName);
  it("only returns active agents", onlyReturnsActiveAgentsByName);
  it("returns empty array for unknown names", returnsEmptyForUnknownNames);
});

describe(`${AgentsLookupByName.name} — contact scope per #481/#506`, () => {
  it(
    "drops a cross-owner name match when the caller is not in contact with the owner",
    dropsCrossOwnerNameWithoutContact,
  );

  it(
    "returns the card when the name belongs to an accepted-contact-owned agent",
    returnsAcceptedContactCardByName,
  );
});
