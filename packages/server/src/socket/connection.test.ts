import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ConnectionId } from "@moltzap/protocol/socket";
import { agentId, conversationId, userId } from "@moltzap/protocol/testing";
import { agentContextFrom, type AgentContext } from "./context.js";
import {
  ConnectionManager,
  type Originator,
  type WebSocketRef,
} from "./connection.js";

const CONN_ID = Schema.decodeUnknownSync(ConnectionId)(
  "00000000-0000-4000-8000-00000000c718",
);
const OTHER_CONN_ID = Schema.decodeUnknownSync(ConnectionId)(
  "00000000-0000-4000-8000-00000000c719",
);
const AGENT_ID = agentId("00000000-0000-4000-8000-00000000a718");
const OWNER_ID = userId("00000000-0000-4000-8000-00000000b718");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000d718");

const socket: WebSocketRef = {
  write: () => Effect.void,
  shutdown: Effect.void,
};

const callback: Originator["callback"] = () =>
  Effect.die("unused test originator");
const originator: Originator = { callback };

function authContext(): Effect.Effect<AgentContext> {
  return agentContextFrom({
    agentId: AGENT_ID,
    agentStatus: "active",
    ownerUserId: OWNER_ID,
  });
}

function authenticateTwoConnections(
  connections: ConnectionManager,
  auth: AgentContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* connections.addUnauthenticated(CONN_ID, socket, originator);
    yield* connections.addUnauthenticated(OTHER_CONN_ID, socket, originator);
    yield* connections.authenticate(CONN_ID, auth);
    yield* connections.authenticate(OTHER_CONN_ID, auth);
  });
}

function expectAgentSubscribed(
  connections: ConnectionManager,
  expected: boolean,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    expect(
      yield* connections.isAgentSubscribedToConversation(
        AGENT_ID,
        CONVERSATION_ID,
      ),
    ).toBe(expected);
  });
}

describe("ConnectionManager conversation subscriptions", () => {
  it("stores conversation membership once per agent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const connections = new ConnectionManager();
        yield* authenticateTwoConnections(connections, yield* authContext());

        yield* connections.hydrateConversationIds(CONN_ID, [CONVERSATION_ID]);

        yield* expectAgentSubscribed(connections, true);

        yield* connections.removeAndReturn(CONN_ID);

        yield* expectAgentSubscribed(connections, true);

        yield* connections.removeConversationFromAgent(
          AGENT_ID,
          CONVERSATION_ID,
        );

        yield* expectAgentSubscribed(connections, false);
      }),
    ));
});
