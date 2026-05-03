import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
  trackClient,
  registerAgent,
  connectTestClient,
} from "./helpers.js";
import type { AgentCard } from "@moltzap/protocol";

import {
  AgentsList,
  AgentsLookup,
  AgentsLookupByName,
  ConversationsCreate,
} from "@moltzap/protocol";

type AgentsListResult = { agents: Record<string, AgentCard> };
type AgentsArrayResult = { agents: AgentCard[] };

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

/** Register an agent with custom options (e.g. description), tracked for cleanup. */
function registerWithOpts(name: string, opts: { description?: string }) {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, name, opts);
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return {
      client,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      name,
    };
  });
}

describe(AgentsList.name, () => {
  it.live("returns co-participant agents from shared conversations", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");
      const bob = yield* registerAndConnect("bob-agent");
      const carol = yield* registerAndConnect("carol-ag");

      yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      });

      yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "group",
        name: "test-group",
        participants: [{ type: "agent", id: carol.agentId }],
      });

      const aliceResult = (yield* alice.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      const aliceAgentIds = Object.keys(aliceResult.agents);
      expect(aliceAgentIds).toContain(bob.agentId);
      expect(aliceAgentIds).toContain(carol.agentId);
      expect(aliceAgentIds).not.toContain(alice.agentId);

      const bobResult = (yield* bob.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      const bobAgentIds = Object.keys(bobResult.agents);
      expect(bobAgentIds).toContain(alice.agentId);
      expect(bobAgentIds).not.toContain(carol.agentId);

      const carolResult = (yield* carol.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      const carolAgentIds = Object.keys(carolResult.agents);
      expect(carolAgentIds).toContain(alice.agentId);
      expect(carolAgentIds).not.toContain(bob.agentId);
    }),
  );

  it.live("returns empty map when agent has no conversations", () =>
    Effect.gen(function* () {
      const loner = yield* registerAndConnect("loner-ag");

      const result = (yield* loner.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      expect(result.agents).toEqual({});
    }),
  );

  it.live("deduplicates agents across multiple shared conversations", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");
      const bob = yield* registerAndConnect("bob-agent");

      yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      });

      yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "group",
        name: "shared-group",
        participants: [{ type: "agent", id: bob.agentId }],
      });

      const result = (yield* alice.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      const agentIds = Object.keys(result.agents);
      expect(agentIds).toHaveLength(1);
      expect(agentIds[0]).toBe(bob.agentId);
    }),
  );

  it.live("excludes the calling agent from results", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");
      const bob = yield* registerAndConnect("bob-agent");

      yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      });

      const result = (yield* alice.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      expect(result.agents[alice.agentId]).toBeUndefined();
      expect(result.agents[bob.agentId]).toBeDefined();
    }),
  );

  it.live("returns agent card fields correctly", () =>
    Effect.gen(function* () {
      const described = yield* registerWithOpts("desc-agent", {
        description: "A test agent",
      });
      const other = yield* registerAndConnect("other-ag");

      yield* described.client.sendRpc(ConversationsCreate.name, {
        type: "dm",
        participants: [{ type: "agent", id: other.agentId }],
      });

      const result = (yield* other.client.sendRpc(
        AgentsList.name,
        {},
      )) as AgentsListResult;
      const card = result.agents[described.agentId];
      expect(card).toBeDefined();
      expect(card.id).toBe(described.agentId);
      expect(card.name).toBe("desc-agent");
      expect(card.description).toBe("A test agent");
      expect(card.status).toBe("active");
    }),
  );
});

describe(AgentsLookup.name, () => {
  it.live("returns agent cards by ID", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");

      const result = (yield* alice.client.sendRpc(AgentsLookup.name, {
        agentIds: [alice.agentId],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].id).toBe(alice.agentId);
      expect(result.agents[0].name).toBe("alice-ag");
      expect(result.agents[0].status).toBe("active");
    }),
  );

  it.live("returns empty array for unknown IDs", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");

      const result = (yield* alice.client.sendRpc(AgentsLookup.name, {
        agentIds: ["00000000-0000-0000-0000-000000000000"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );

  it.live("includes description in lookup results", () =>
    Effect.gen(function* () {
      const described = yield* registerWithOpts("desc-agent", {
        description: "Has a description",
      });

      const result = (yield* described.client.sendRpc(AgentsLookup.name, {
        agentIds: [described.agentId],
      })) as AgentsArrayResult;

      expect(result.agents[0].description).toBe("Has a description");
    }),
  );
});

describe(AgentsLookupByName.name, () => {
  it.live("returns agent cards by name", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");

      const result = (yield* alice.client.sendRpc(AgentsLookupByName.name, {
        names: ["alice-ag"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].id).toBe(alice.agentId);
      expect(result.agents[0].name).toBe("alice-ag");
    }),
  );

  it.live("only returns active agents", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");

      const db = getKyselyDb();
      yield* Effect.tryPromise(() =>
        db
          .updateTable("agents")
          .set({ status: "suspended" })
          .where("id", "=", alice.agentId)
          .execute(),
      );

      const bob = yield* registerAndConnect("bob-agent");
      const result = (yield* bob.client.sendRpc(AgentsLookupByName.name, {
        names: ["alice-ag"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );

  it.live("returns empty array for unknown names", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-ag");

      const result = (yield* alice.client.sendRpc(AgentsLookupByName.name, {
        names: ["nonexistent"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );
});
