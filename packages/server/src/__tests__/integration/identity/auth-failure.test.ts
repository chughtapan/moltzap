import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import {
  it,
  connectTestClient,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAgent,
} from "../helpers.js";
import { getCoreDb } from "../../../test-utils/index.js";

import { Connect } from "@moltzap/protocol";

const BAD_AGENT_ID = "00000000-0000-4000-8000-000000000bad";
// Carry the agent prefix so the credential reaches agent-key validation
// (`completeAgentConnect`) and fails there with "Authentication failed",
// rather than short-circuiting at the unrecognized-prefix gate.
const INVALID_API_KEY = "moltzap_agent_invalid_key_12345";
const FAKE_API_KEY = "moltzap_agent_totally_fake_api_key_000000000000";
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

it("bad API key is rejected with authentication error", () =>
  Effect.gen(function* () {
    const client = yield* connectTestClient({
      wsUrl,
      agentId: BAD_AGENT_ID,
      apiKey: INVALID_API_KEY,
      autoConnect: false,
    });

    const result = yield* Effect.exit(
      client.sendRpc(Connect, {
        credential: INVALID_API_KEY,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      }),
    );
    expectFailureCauseContains(result, AUTHENTICATION_FAILED_MESSAGE);

    yield* client.close();
  }));

it("unauthenticated RPC call is rejected", () =>
  Effect.gen(function* () {
    const client = yield* connectTestClient({
      wsUrl,
      agentId: BAD_AGENT_ID,
      apiKey: FAKE_API_KEY,
      autoConnect: false,
    });

    const result = yield* Effect.exit(
      client.sendRpc(Connect, {
        credential: FAKE_API_KEY,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      }),
    );
    expectFailureCauseContains(result, AUTHENTICATION_FAILED_MESSAGE);

    yield* client.close();
  }));

it("suspended agent cannot call protected RPCs", () =>
  Effect.gen(function* () {
    const reg = yield* registerAgent(baseUrl, "suspended-agent");

    // Suspend via direct DB update
    const db = getCoreDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ status: SUSPENDED_STATUS })
        .where("id", "=", reg.agentId)
        .execute(),
    );

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
    expectExitFailure(result);

    yield* client.close();
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
