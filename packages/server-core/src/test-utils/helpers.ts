import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { getBaseUrl, getWsUrl } from "./index.js";

export interface ConnectedAgent {
  client: MoltZapTestClient;
  agentId: string;
  apiKey: string;
  name: string;
}

const openClients: MoltZapTestClient[] = [];

export function trackClient(client: MoltZapTestClient): void {
  openClients.push(client);
}

export function closeAllClients(): void {
  for (const c of openClients) c.close();
  openClients.length = 0;
}

/** Register and connect an agent. Tracked for automatic cleanup. */
export async function registerAndConnect(
  name: string,
): Promise<ConnectedAgent> {
  const baseUrl = getBaseUrl();
  const wsUrl = getWsUrl();
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  openClients.push(client);
  const reg = await client.register(name);
  await client.connect(reg.apiKey);
  return { client, agentId: reg.agentId, apiKey: reg.apiKey, name };
}

/** Register an agent without connecting (for tests that need the raw client). */
export async function registerOnly(name: string): Promise<{
  client: MoltZapTestClient;
  agentId: string;
  apiKey: string;
  claimToken: string;
}> {
  const baseUrl = getBaseUrl();
  const wsUrl = getWsUrl();
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  openClients.push(client);
  const reg = await client.register(name);
  return {
    client,
    agentId: reg.agentId,
    apiKey: reg.apiKey,
    claimToken: reg.claimToken,
  };
}

/** Create two agents, both connected. No contacts needed (core has open access). */
export async function setupAgentPair(): Promise<{
  alice: ConnectedAgent;
  bob: ConnectedAgent;
}> {
  const alice = await registerAndConnect("alice");
  const bob = await registerAndConnect("bob");
  return { alice, bob };
}

/** Create N agents, all connected. Optionally create a group conversation. */
export async function setupAgentGroup(
  count: number,
  opts?: { groupName?: string },
): Promise<{
  agents: ConnectedAgent[];
  conversationId?: string;
}> {
  if (count < 2) throw new Error("Agent group requires at least 2 agents");

  const agents: ConnectedAgent[] = [];
  for (let i = 0; i < count; i++) {
    agents.push(await registerAndConnect(`agent-${i}`));
  }

  let conversationId: string | undefined;
  if (opts?.groupName) {
    const creator = agents[0]!;
    const others = agents.slice(1).map((a) => ({
      type: "agent" as const,
      id: a.agentId,
    }));
    const conv = (await creator.client.rpc("conversations/create", {
      type: "group",
      name: opts.groupName,
      participants: others,
    })) as { conversation: { id: string } };
    conversationId = conv.conversation.id;
  }

  return { agents, conversationId };
}
