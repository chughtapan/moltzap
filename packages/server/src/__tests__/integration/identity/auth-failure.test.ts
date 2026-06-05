import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  it,
  connectTestClient,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  createTestAgent,
} from "../helpers.js";
import { getCoreDb } from "../../../test-utils/index.js";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";

const BAD_AGENT_ID = agentId("00000000-0000-4000-8000-000000000bad");
const INVALID_API_KEY = redactedAgentKey(agentKeyString(99));
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

it("bad API key is rejected with authentication error", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      connectTestClient({
        wsUrl,
        agentId: BAD_AGENT_ID,
        apiKey: INVALID_API_KEY,
      }),
    );
    expectFailureCauseContains(result, AUTHENTICATION_FAILED_MESSAGE);
  }));

it("suspended agent cannot call protected RPCs", () =>
  Effect.gen(function* () {
    const reg = yield* createTestAgent("suspended-agent");

    // Suspend via direct DB update
    const db = getCoreDb();
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
    expectExitFailure(result);
  }));

function expectFailureCauseContains<A, E>(
  exit: Exit.Exit<A, E>,
  expectedMessage: string,
): void {
  expectExitFailure(exit);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain(expectedMessage);
  }
}

function expectExitFailure<A, E>(exit: Exit.Exit<A, E>): void {
  expect(exit).toSatisfy(Exit.isFailure);
}
