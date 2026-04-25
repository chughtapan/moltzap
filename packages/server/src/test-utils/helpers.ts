import { Effect } from "effect";
import type { EventFrame } from "@moltzap/protocol";
import {
  makeCloseableTestClient,
  registerTestAgent,
  type CloseableTestClient,
  type TestAgent,
} from "@moltzap/protocol/testing";
import { getBaseUrl, getWsUrl } from "./index.js";

export interface ServerTestClient
  extends Omit<CloseableTestClient, "close" | "drainEvents"> {
  close(): Effect.Effect<void, never>;
  drainEvents(): ReadonlyArray<EventFrame>;
}

export interface ConnectedAgent {
  client: ServerTestClient;
  agentId: string;
  apiKey: string;
  name: string;
}

const openClients: ServerTestClient[] = [];

export function trackClient(client: ServerTestClient): void {
  openClients.push(client);
}

export function closeAllClients(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const c of openClients) yield* c.close();
    openClients.length = 0;
  });
}

export function registerAgent(
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<TestAgent, Error> {
  return registerTestAgent({
    baseUrl,
    name,
    description: opts?.description,
    inviteCode: opts?.inviteCode,
    uniqueSuffix: false,
  });
}

export function connectTestClient(opts: {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  autoConnect?: boolean;
}): Effect.Effect<ServerTestClient, Error> {
  return Effect.gen(function* () {
    const client = yield* makeCloseableTestClient({
      serverUrl: opts.wsUrl ?? getWsUrl(),
      agentId: opts.agentId,
      agentKey: opts.apiKey,
      defaultTimeoutMs: 5000,
      captureCapacity: 1024,
      autoConnect: opts.autoConnect,
    });
    return {
      ...client,
      close: () => client.close,
      drainEvents: () => Effect.runSync(client.drainEvents),
    };
  });
}

/** Register and connect an agent. Tracked for automatic cleanup. */
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const { agentId, apiKey } = yield* registerAgent(getBaseUrl(), name);
    const client = yield* connectTestClient({ agentId, apiKey });
    openClients.push(client);
    return { client, agentId, apiKey, name };
  });
}

/** Register an agent without connecting (for tests that need the raw client). */
export function registerOnly(name: string): Effect.Effect<
  {
    client: ServerTestClient;
    agentId: string;
    apiKey: string;
    claimToken: string | undefined;
  },
  Error
> {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(getBaseUrl(), name);
    const client = yield* connectTestClient({
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      autoConnect: false,
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
