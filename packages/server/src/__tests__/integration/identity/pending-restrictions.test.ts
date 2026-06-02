import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  getKyselyDb,
  registerAgent,
  connectTestClient,
} from "../helpers.js";

import { Connect, TaskConversationList } from "@moltzap/protocol";

const SUSPENDED_STATUS = "suspended";
const AUTHENTICATION_FAILED_MESSAGE = "Authentication failed";

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

it("suspended agent cannot connect", () =>
  Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, "suspend-agent");

    // Suspend the agent via DB
    const db = getKyselyDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ status: SUSPENDED_STATUS })
        .where("id", "=", reg.agentId)
        .execute(),
    );

    // Cannot connect
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
    expectFailureCauseContains(result, AUTHENTICATION_FAILED_MESSAGE);

    yield* client.close();
  }));

it("active agent works normally after registration", () =>
  Effect.gen(function* () {
    const { client } = yield* registerAndConnect("active-agent");

    // Should work immediately — agents are active on registration in core
    const result = yield* client.sendRpc(TaskConversationList, {});
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
