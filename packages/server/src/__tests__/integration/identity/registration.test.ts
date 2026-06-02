import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import {
  connectTestClient,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAgent,
} from "../helpers.js";
import { getCoreDb } from "../../../test-utils/index.js";
import type { AgentId } from "@moltzap/protocol/identity";

import { Connect, TaskConversationList } from "@moltzap/protocol";

let baseUrl: string;
let wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      baseUrl = server.baseUrl;
      wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function registersAgent() {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, "test-agent");

    expect(reg.agentId).toBeDefined();
    expect(reg.apiKey).toMatch(/^moltzap_agent_/);
  });
}

function rejectsDuplicateAgentNames() {
  return Effect.gen(function* () {
    yield* registerAgent(baseUrl, "unique-agent");

    const result = yield* Effect.exit(registerAgent(baseUrl, "unique-agent"));
    expect(Exit.isFailure(result)).toBe(true);
  });
}

function registeredAgentCanUseMethods() {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, "active-agent");
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      autoConnect: false,
    });

    const hello = yield* client.sendRpc(Connect, {
      credential: reg.apiKey,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
    // The HelloOk is empty: a successful connect is the only signal.
    expect(hello).toEqual({});

    const result = yield* client.sendRpc(TaskConversationList, {});
    expect(result.items).toEqual([]);

    yield* client.close();
  });
}

function suspendAgent(agentId: AgentId) {
  const db = getCoreDb();
  return Effect.tryPromise(() =>
    db
      .updateTable("agents")
      .set({ status: "suspended" })
      .where("id", "=", agentId)
      .execute(),
  );
}

function suspendedAgentCannotConnect() {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, "suspended-agent");
    yield* suspendAgent(reg.agentId);

    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      autoConnect: false,
    });
    const result = yield* Effect.exit(
      client.sendRpc(Connect, {
        credential: reg.apiKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);

    yield* client.close();
  });
}

describe("Scenario 1: Registration", () => {
  it("registers an agent and returns API key", registersAgent);
  it("rejects duplicate agent names", rejectsDuplicateAgentNames);
  it(
    "registered agent is active immediately and can use all methods",
    registeredAgentCanUseMethods,
  );
  it("suspended agent cannot connect", suspendedAgentCannotConnect);
});
