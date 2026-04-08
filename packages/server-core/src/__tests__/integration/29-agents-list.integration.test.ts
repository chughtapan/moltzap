import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
  MoltZapTestClient,
  trackClient,
} from "./helpers.js";
import type { AgentCard } from "@moltzap/protocol";

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
async function registerWithOpts(name: string, opts: { description?: string }) {
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  trackClient(client);
  const reg = await client.register(name, opts);
  await client.connect(reg.apiKey);
  return { client, agentId: reg.agentId, apiKey: reg.apiKey, name };
}

describe("agents/list", () => {
  it("returns co-participant agents from shared conversations", async () => {
    const alice = await registerAndConnect("alice-ag");
    const bob = await registerAndConnect("bob-agent");
    const carol = await registerAndConnect("carol-ag");

    await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    });

    await alice.client.rpc("conversations/create", {
      type: "group",
      name: "test-group",
      participants: [{ type: "agent", id: carol.agentId }],
    });

    const aliceResult = (await alice.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    const aliceAgentIds = Object.keys(aliceResult.agents);
    expect(aliceAgentIds).toContain(bob.agentId);
    expect(aliceAgentIds).toContain(carol.agentId);
    expect(aliceAgentIds).not.toContain(alice.agentId);

    const bobResult = (await bob.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    const bobAgentIds = Object.keys(bobResult.agents);
    expect(bobAgentIds).toContain(alice.agentId);
    expect(bobAgentIds).not.toContain(carol.agentId);

    const carolResult = (await carol.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    const carolAgentIds = Object.keys(carolResult.agents);
    expect(carolAgentIds).toContain(alice.agentId);
    expect(carolAgentIds).not.toContain(bob.agentId);
  });

  it("returns empty map when agent has no conversations", async () => {
    const loner = await registerAndConnect("loner-ag");

    const result = (await loner.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    expect(result.agents).toEqual({});
  });

  it("deduplicates agents across multiple shared conversations", async () => {
    const alice = await registerAndConnect("alice-ag");
    const bob = await registerAndConnect("bob-agent");

    await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    });

    await alice.client.rpc("conversations/create", {
      type: "group",
      name: "shared-group",
      participants: [{ type: "agent", id: bob.agentId }],
    });

    const result = (await alice.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    const agentIds = Object.keys(result.agents);
    expect(agentIds).toHaveLength(1);
    expect(agentIds[0]).toBe(bob.agentId);
  });

  it("excludes the calling agent from results", async () => {
    const alice = await registerAndConnect("alice-ag");
    const bob = await registerAndConnect("bob-agent");

    await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    });

    const result = (await alice.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    expect(result.agents[alice.agentId]).toBeUndefined();
    expect(result.agents[bob.agentId]).toBeDefined();
  });

  it("returns agent card fields correctly", async () => {
    const described = await registerWithOpts("desc-agent", {
      description: "A test agent",
    });
    const other = await registerAndConnect("other-ag");

    await described.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: other.agentId }],
    });

    const result = (await other.client.rpc(
      "agents/list",
      {},
    )) as AgentsListResult;
    const card = result.agents[described.agentId];
    expect(card).toBeDefined();
    expect(card.id).toBe(described.agentId);
    expect(card.name).toBe("desc-agent");
    expect(card.description).toBe("A test agent");
    expect(card.status).toBe("active");
  });
});

describe("agents/lookup", () => {
  it("returns agent cards by ID", async () => {
    const alice = await registerAndConnect("alice-ag");

    const result = (await alice.client.rpc("agents/lookup", {
      agentIds: [alice.agentId],
    })) as AgentsArrayResult;

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe(alice.agentId);
    expect(result.agents[0].name).toBe("alice-ag");
    expect(result.agents[0].status).toBe("active");
  });

  it("returns empty array for unknown IDs", async () => {
    const alice = await registerAndConnect("alice-ag");

    const result = (await alice.client.rpc("agents/lookup", {
      agentIds: ["00000000-0000-0000-0000-000000000000"],
    })) as AgentsArrayResult;

    expect(result.agents).toHaveLength(0);
  });

  it("includes description in lookup results", async () => {
    const described = await registerWithOpts("desc-agent", {
      description: "Has a description",
    });

    const result = (await described.client.rpc("agents/lookup", {
      agentIds: [described.agentId],
    })) as AgentsArrayResult;

    expect(result.agents[0].description).toBe("Has a description");
  });
});

describe("agents/lookupByName", () => {
  it("returns agent cards by name", async () => {
    const alice = await registerAndConnect("alice-ag");

    const result = (await alice.client.rpc("agents/lookupByName", {
      names: ["alice-ag"],
    })) as AgentsArrayResult;

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe(alice.agentId);
    expect(result.agents[0].name).toBe("alice-ag");
  });

  it("only returns active agents", async () => {
    const alice = await registerAndConnect("alice-ag");

    const db = getKyselyDb();
    await db
      .updateTable("agents")
      .set({ status: "suspended" })
      .where("id", "=", alice.agentId)
      .execute();

    const bob = await registerAndConnect("bob-agent");
    const result = (await bob.client.rpc("agents/lookupByName", {
      names: ["alice-ag"],
    })) as AgentsArrayResult;

    expect(result.agents).toHaveLength(0);
  });

  it("returns empty array for unknown names", async () => {
    const alice = await registerAndConnect("alice-ag");

    const result = (await alice.client.rpc("agents/lookupByName", {
      names: ["nonexistent"],
    })) as AgentsArrayResult;

    expect(result.agents).toHaveLength(0);
  });
});
