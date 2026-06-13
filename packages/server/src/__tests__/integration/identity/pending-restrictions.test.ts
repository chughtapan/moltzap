import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
  createTestAgent,
  connectTestClient,
} from "../helpers.js";

import { ConversationList } from "@moltzap/protocol/conversation";

const SUSPENDED_STATUS = "suspended";
const AUTHENTICATION_FAILED_MESSAGE = "Authentication failed";

let wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("suspended agent cannot connect", () =>
  Effect.gen(function* () {
    const reg = yield* createTestAgent("suspend-agent");

    // Suspend the agent via DB
    const db = getKyselyDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ status: SUSPENDED_STATUS })
        .where("id", "=", reg.agentId)
        .execute(),
    );

    const result = yield* Effect.exit(
      connectTestClient({
        wsUrl,
        agentId: reg.agentId,
        apiKey: reg.apiKey,
      }),
    );
    expectFailureCauseContains(result, AUTHENTICATION_FAILED_MESSAGE);
  }));

it("active agent works normally after registration", () =>
  Effect.gen(function* () {
    const { client } = yield* registerAndConnect("active-agent");

    // Should work immediately — agents are active on registration in core
    const result = yield* client.sendRpc(ConversationList, {});
    expect(result.items).toEqual([]);

    yield* client.close();
  }));

function expectFailureCauseContains<A, E>(
  exit: Exit.Exit<A, E>,
  expectedMessage: string,
): void {
  expect(exit).toSatisfy(Exit.isFailure);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain(expectedMessage);
  }
}
