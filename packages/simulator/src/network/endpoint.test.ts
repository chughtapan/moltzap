/** @file Endpoint address binding, semantic START delegation, and exhausted-inbox regressions. */

import { assert, it } from "@effect/vitest";
import { AgentName, ConversationId, type StartInput } from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import { Effect, Schema, Stream } from "effect";
import { makeConversationAddress } from "./conversation.js";
import { type EndpointInbox, makeEndpoint } from "./endpoint.js";
import { NetworkError } from "./failure.js";
import { makeParticipantHandle } from "./participant.js";

const RECEIVE_OPERATION: NetworkError["operation"] = "receive";
const SOCKET_OPERATION: NetworkError["operation"] = "socket";

const observerId = Schema.decodeUnknownSync(AgentId)(
  "agt_AAAAAAAAAAAAAAAAAAAAAA",
);
const otherId = Schema.decodeUnknownSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAg");
const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000102",
);
const otherName = Schema.decodeUnknownSync(AgentName)("other");
const startInput: StartInput = {
  conversationId,
  peers: [otherName],
  content: [{ type: "text", text: "hello" }],
};

const inbox: EndpointInbox = {
  messages: Stream.empty,
  conversation: () => Effect.succeed(Stream.empty),
};

// @agent-code-guard/regression-only: the receive-only socket preserves addressed binding and reports exhausted semantic input through the typed network channel
it("binds an addressed receive-only conversation socket", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const participant = makeParticipantHandle("observer", observerId);
      const endpoint = makeEndpoint(
        {
          participant,
          transport: { received: Stream.empty, start: () => Effect.void },
        },
        inbox,
      );
      const address = makeConversationAddress(conversationId, [participant]);
      const socket = yield* endpoint.socket(address);
      const failure = yield* socket.receive().pipe(Effect.flip);

      assert.strictEqual(socket.endpoint, participant);
      assert.strictEqual(socket.address, address);
      assert.instanceOf(failure, NetworkError);
      assert.strictEqual(failure.operation, RECEIVE_OPERATION);
    }),
  ));

it.effect("rejects an address that excludes the endpoint", () =>
  Effect.gen(function* () {
    const participant = makeParticipantHandle("observer", observerId);
    const other = makeParticipantHandle("other", otherId);
    const endpoint = makeEndpoint(
      {
        participant,
        transport: { received: Stream.empty, start: () => Effect.void },
      },
      inbox,
    );
    const address = makeConversationAddress(conversationId, [other]);
    const failure = yield* endpoint.socket(address).pipe(Effect.flip);

    assert.instanceOf(failure, NetworkError);
    assert.strictEqual(failure.operation, SOCKET_OPERATION);
  }),
);

it.effect("delegates semantic START without exposing its daemon client", () =>
  Effect.gen(function* () {
    const participant = makeParticipantHandle("observer", observerId);
    let observed: StartInput | undefined;
    const endpoint = makeEndpoint(
      {
        participant,
        transport: {
          received: Stream.empty,
          start: (input) =>
            Effect.sync(() => {
              observed = input;
            }),
        },
      },
      inbox,
    );

    yield* endpoint.start(startInput);

    assert.strictEqual(observed, startInput);
  }),
);
