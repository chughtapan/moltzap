import { it as effectIt } from "@effect/vitest";
import type { RpcSerialization } from "@effect/rpc";
import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import {
  type ConversationId,
  conversationId as conversationIdSchema,
} from "@moltzap/protocol/conversation";
import {
  connectionIdSchema,
  type ReverseClient,
} from "@moltzap/protocol/socket";
import { agentId, userId } from "@moltzap/protocol/testing";
import {
  agentContextFrom,
  type AgentContext,
  ConnectionManager,
} from "./connection.js";

const CONN_ID = Schema.decodeUnknownSync(connectionIdSchema)(
  "00000000-0000-4000-8000-00000000c718",
);
const OTHER_CONN_ID = Schema.decodeUnknownSync(connectionIdSchema)(
  "00000000-0000-4000-8000-00000000c719",
);
const AGENT_ID = agentId("00000000-0000-4000-8000-00000000a718");
const OWNER_ID = userId("00000000-0000-4000-8000-00000000b718");
const decodeConversationId = Schema.decodeSync(conversationIdSchema);
const CONVERSATION_ID = decodeConversationId(
  "00000000-0000-4000-8000-00000000d718",
);
const CURRENT_CONVERSATION_ID = decodeConversationId(
  "00000000-0000-4000-8000-00000000d719",
);

const unusedOriginatorOp = () => Effect.dieMessage("unused test originator");

function makeUnusedParser(): RpcSerialization.Parser {
  const fail = () =>
    Effect.runSync(Effect.dieMessage("unused test originator parser"));
  return { decode: fail, encode: fail };
}

const originator: ReverseClient = {
  call: unusedOriginatorOp,
  notify: unusedOriginatorOp,
  sink: {
    parser: makeUnusedParser(),
    inject: unusedOriginatorOp,
  },
};

const it = effectIt.effect;

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
    yield* connections.addUnauthenticated(CONN_ID, originator);
    yield* connections.addUnauthenticated(OTHER_CONN_ID, originator);
    yield* connections.authenticate(CONN_ID, auth);
    yield* connections.authenticate(OTHER_CONN_ID, auth);
  });
}

function expectAgentSubscribed(
  connections: ConnectionManager,
  id: ConversationId,
  expected: boolean,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    expect(
      yield* connections.isAgentSubscribedToConversation(AGENT_ID, id),
    ).toBe(expected);
  });
}

describe("ConnectionManager conversation subscriptions", () => {
  it("shares membership across sockets and resets after last disconnect", () =>
    Effect.gen(function* () {
      const connections = new ConnectionManager();
      yield* authenticateTwoConnections(connections, yield* authContext());

      yield* connections.hydrateConversationIds(CONN_ID, [CONVERSATION_ID]);
      yield* connections.addConversationToAgents(
        [AGENT_ID],
        CURRENT_CONVERSATION_ID,
      );

      yield* expectAgentSubscribed(connections, CONVERSATION_ID, true);
      yield* expectAgentSubscribed(connections, CURRENT_CONVERSATION_ID, true);

      yield* connections.removeAndReturn(CONN_ID);

      yield* expectAgentSubscribed(connections, CONVERSATION_ID, true);
      yield* expectAgentSubscribed(connections, CURRENT_CONVERSATION_ID, true);

      yield* connections.removeAndReturn(OTHER_CONN_ID);

      yield* expectAgentSubscribed(connections, CONVERSATION_ID, false);
      yield* expectAgentSubscribed(connections, CURRENT_CONVERSATION_ID, false);

      yield* connections.addUnauthenticated(CONN_ID, originator);
      yield* connections.authenticate(CONN_ID, yield* authContext());
      yield* connections.hydrateConversationIds(CONN_ID, [
        CURRENT_CONVERSATION_ID,
      ]);

      yield* expectAgentSubscribed(connections, CONVERSATION_ID, false);
      yield* expectAgentSubscribed(connections, CURRENT_CONVERSATION_ID, true);
    }));

  it("does not cache subscriptions for disconnected agents", () =>
    Effect.gen(function* () {
      const connections = new ConnectionManager();

      yield* connections.addConversationToAgents([AGENT_ID], CONVERSATION_ID);

      yield* expectAgentSubscribed(connections, CONVERSATION_ID, false);
    }));
});
