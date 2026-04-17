import { Effect } from "effect";
import { MoltZapWsClient } from "@moltzap/client";
import {
  registerAgent,
  registerAndConnect as registerAndConnectClient,
  stripWsPath,
} from "@moltzap/client/test";
import { getBaseUrl, getWsUrl } from "./index.js";

export interface ConnectedAgent {
  client: MoltZapWsClient;
  agentId: string;
  apiKey: string;
  name: string;
}

const openClients: MoltZapWsClient[] = [];

export function trackClient(client: MoltZapWsClient): void {
  openClients.push(client);
}

export function closeAllClients(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const c of openClients) yield* c.close();
    openClients.length = 0;
  });
}

/** Register and connect an agent. Tracked for automatic cleanup. */
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const { client, agentId, apiKey } = yield* registerAndConnectClient(
      getBaseUrl(),
      getWsUrl(),
      name,
    );
    openClients.push(client);
    return { client, agentId, apiKey, name };
  });
}

/** Register an agent without connecting (for tests that need the raw client). */
export function registerOnly(name: string): Effect.Effect<
  {
    client: MoltZapWsClient;
    agentId: string;
    apiKey: string;
    claimToken: string;
  },
  Error
> {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(getBaseUrl(), name);
    const client = new MoltZapWsClient({
      serverUrl: stripWsPath(getWsUrl()),
      agentKey: reg.apiKey,
    });
    openClients.push(client);
    return {
      client,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      claimToken: reg.claimToken,
    };
  });
}

/** Create two agents, both connected. No contacts needed (core has open access). */
export function setupAgentPair(): Effect.Effect<
  { alice: ConnectedAgent; bob: ConnectedAgent },
  Error
> {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    return { alice, bob };
  });
}

/** Create N agents, all connected. Optionally create a group conversation. */
export function setupAgentGroup(
  count: number,
  opts?: { groupName?: string },
): Effect.Effect<{ agents: ConnectedAgent[]; conversationId?: string }, Error> {
  return Effect.gen(function* () {
    if (count < 2) {
      return yield* Effect.fail(
        new Error("Agent group requires at least 2 agents"),
      );
    }

    const agents: ConnectedAgent[] = [];
    for (let i = 0; i < count; i++) {
      agents.push(yield* registerAndConnect(`agent-${i}`));
    }

    let conversationId: string | undefined;
    if (opts?.groupName) {
      const creator = agents[0]!;
      const others = agents.slice(1).map((a) => ({
        type: "agent" as const,
        id: a.agentId,
      }));
      const conv = (yield* creator.client.sendRpc("conversations/create", {
        type: "group",
        name: opts.groupName,
        participants: others,
      })) as { conversation: { id: string } };
      conversationId = conv.conversation.id;
    }

    return { agents, conversationId };
  });
}
