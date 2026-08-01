import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  createTestUser,
  registerOwnedAgent,
} from "../helpers.js";
import {
  type AgentCard,
  type UserId,
  agentsList,
} from "@moltzap/protocol/identity";
import { userId } from "@moltzap/protocol/testing";

const it = effectIt.live;

interface AgentsListResult {
  agents: AgentCard[];
  nextCursor?: string;
}

// agent/identity/agents/list returns every registered agent; these fixtures
// bind explicit owners so cross-owner cases are exercised.
const REGISTRATION_SECRET = "agents-list-test-secret-zxcv";
const ALICE_USER_ID = userId("00000000-0000-4000-8000-00000000a11c");
const BOB_USER_ID = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL_USER_ID = userId("00000000-0000-4000-8000-00000000ca60");
const ALICE_USER = createTestUser("alice", ALICE_USER_ID);
const BOB_USER = createTestUser("bob", BOB_USER_ID);
const CAROL_USER = createTestUser("carol", CAROL_USER_ID);
const AGENT_DESCRIPTION = "A test agent";
const AGENT_STATUS_ACTIVE = "active";

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

function registerOwned(
  name: string,
  ownerUserId: UserId,
  description?: string,
) {
  const user = userForOwner(ownerUserId);
  return registerOwnedAgent({
    baseUrl,
    inviteCode: REGISTRATION_SECRET,
    name,
    user,
    description,
  });
}

function userForOwner(ownerUserId: UserId) {
  if (ownerUserId === ALICE_USER_ID) {
    return ALICE_USER;
  }
  if (ownerUserId === BOB_USER_ID) {
    return BOB_USER;
  }
  return CAROL_USER;
}

interface OwnedConnectedAgent {
  agentId: string;
  ownerUserId: UserId;
  client: Effect.Effect.Success<ReturnType<typeof connectTestClient>>;
}

function registerAndConnectOwned(opts: {
  name: string;
  ownerUserId: UserId;
  description?: string;
}) {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const reg = yield* registerOwned(
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
  return /* Safe because the test fixture establishes this asserted shape. */ agent.client.sendRpc(
    agentsList,
    {},
  ) as Effect.Effect<AgentsListResult>;
}

function agentIds(result: AgentsListResult) {
  return result.agents.map((a) => a.id);
}

function cardForAgent(result: AgentsListResult, agentId: string) {
  return result.agents.find((a) => a.id === agentId);
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

function returnsOwnAgents() {
  return Effect.gen(function* () {
    const alice1 = yield* connectAlice("alice-sib1");
    const alice2 = yield* connectAlice("alice-sib2");

    const result = yield* listAgents(alice1);
    expectListIncludes(result, [alice1.agentId, alice2.agentId]);
  });
}

function returnsAgentsAcrossOwners() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-x");
    const bob = yield* connectBob("bob-x");
    const carol = yield* connectCarol("carol-x");

    const aliceList = yield* listAgents(alice);
    expectListIncludes(aliceList, [alice.agentId, bob.agentId, carol.agentId]);

    const bobList = yield* listAgents(bob);
    expectListIncludes(bobList, [bob.agentId, alice.agentId, carol.agentId]);
  });
}

function returnsAgentCardFields() {
  return Effect.gen(function* () {
    const alice = yield* connectAlice("alice-card");
    const bob = yield* connectBob("bob-card", AGENT_DESCRIPTION);

    const result = yield* listAgents(alice);
    const card = cardForAgent(result, bob.agentId);
    expect(card).toBeDefined();
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ card!
        .id,
    ).toBe(bob.agentId);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ card!
        .description,
    ).toBe(AGENT_DESCRIPTION);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ card!
        .status,
    ).toBe(AGENT_STATUS_ACTIVE);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ card!
        .ownerUserId,
    ).toBe(BOB_USER_ID);
  });
}

describe(`${agentsList.name} — visibility`, () => {
  it("returns own agents (siblings under same ownerUserId)", returnsOwnAgents);

  it("returns agents owned by every other user", returnsAgentsAcrossOwners);
});

describe(`${agentsList.name} — card shape`, () => {
  it("returns the AgentCard fields correctly", returnsAgentCardFields);
});
