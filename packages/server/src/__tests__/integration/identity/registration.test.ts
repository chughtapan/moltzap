import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  connectTestClient,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAgent,
} from "../helpers.js";
import { getCoreDb } from "../../../test-utils/server.js";
import type { AgentId } from "@moltzap/protocol/identity";

import { conversationList } from "@moltzap/protocol/conversation";

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
    });

    const result = yield* client.sendRpc(conversationList, {});
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

    const result = yield* Effect.exit(
      connectTestClient({
        wsUrl,
        agentId: reg.agentId,
        apiKey: reg.apiKey,
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
}

describe("Scenario 1: Registration", () => {
  it("rejects duplicate agent names", rejectsDuplicateAgentNames);
  it(
    "registered agent is active immediately and can use all methods",
    registeredAgentCanUseMethods,
  );
  it("suspended agent cannot connect", suspendedAgentCannotConnect);
});
