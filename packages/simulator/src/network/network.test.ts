/* eslint-disable agent-code-guard/no-example-only-tests -- These pin the endpoint contract's fixed shapes: who a conversation opens with, which content the transport refuses, how one operation reads whether its cause was thrown or described, and what a stopped router leaves behind. None is an invariant over generated input. */

import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import {
  Endpoint,
  NetworkError,
  type RouterStopped,
  makeEndpoint,
  makeParticipantHandle,
  makeRouterStopReport,
  networkError,
  routerSequence,
  type EndpointInbox,
  type EndpointTransport,
  type NetworkOperation,
  type ParticipantIds,
} from "../network.js";

const SEND_OPERATION = "send" satisfies NetworkOperation;
const BOUNDARY_DETAIL = "the boundary refused the request";
const id = (suffix: string) =>
  agentId(`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000102");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000103");
function makeTransport(
  openedWith: ParticipantIds[],
  onSendInput?: () => void,
): EndpointTransport {
  const onSend = onSendInput ?? (() => undefined);
  return {
    received: Stream.empty,
    openConversation: (participants) =>
      Effect.sync(() => {
        openedWith.push(participants);
        return { conversationId: CONVERSATION_ID };
      }),
    send: () => Effect.sync(onSend).pipe(Effect.zipRight(Effect.never)),
  };
}

function stoppedRouter(): RouterStopped {
  return makeRouterStopReport([
    {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      senderId: id("1"),
      routerSequence: routerSequence(0),
    },
  ]);
}

it.effect(
  "opens through an endpoint and binds another addressed endpoint",
  () =>
    Effect.gen(function* () {
      const openedWith: ParticipantIds[] = [];
      const inbox: EndpointInbox = {
        messages: Stream.empty,
        conversation: () => Effect.succeed(Stream.empty),
      };
      const probe = makeEndpoint(
        {
          participant: makeParticipantHandle("probe", id("2")),
          transport: makeTransport(openedWith),
        },
        inbox,
      );
      const observer = makeEndpoint(
        {
          participant: makeParticipantHandle("observer", id("3")),
          transport: makeTransport(openedWith),
        },
        inbox,
      );
      const socket = yield* probe.open(observer.participant);
      const observerSocket = yield* observer.socket(socket.address);

      assert.isTrue(probe instanceof Endpoint);
      assert.strictEqual(openedWith.length, 1);
      assert.deepStrictEqual(openedWith[0], [observer.participant.id]);
      assert.deepStrictEqual(
        socket.address.participants.map((participant) => participant.id),
        [probe.participant.id, observer.participant.id],
      );
      assert.strictEqual(observerSocket.endpoint.id, observer.participant.id);
    }),
);

it.effect("rejects invalid content before calling the transport", () =>
  Effect.gen(function* () {
    const openedWith: ParticipantIds[] = [];
    let sends = 0;
    const inbox: EndpointInbox = {
      messages: Stream.empty,
      conversation: () => Effect.succeed(Stream.empty),
    };
    const probe = makeEndpoint(
      {
        participant: makeParticipantHandle("probe", id("2")),
        transport: makeTransport(openedWith, () => {
          sends += 1;
        }),
      },
      inbox,
    );
    const target = makeParticipantHandle("target", id("3"));
    const socket = yield* probe.open(target);
    const failure = yield* socket
      .send([{ type: "text", text: "" }])
      .pipe(Effect.flip);

    assert.instanceOf(failure, NetworkError);
    assert.strictEqual(failure.operation, SEND_OPERATION);
    assert.strictEqual(sends, 0);
  }),
);

it("reads one operation the same way for a thrown and a described cause", () => {
  const thrown = networkError(SEND_OPERATION, new Error(BOUNDARY_DETAIL));
  const described = networkError(SEND_OPERATION, BOUNDARY_DETAIL);

  assert.strictEqual(thrown.detail, described.detail);
  assert.strictEqual(thrown.detail, BOUNDARY_DETAIL);
});

it("constructs stopped-router evidence without platform storage", () => {
  const stopped = stoppedRouter();

  assert.strictEqual(stopped.committedMessages.length, 1);
  assert.strictEqual(stopped.committedMessages[0]?.routerSequence, 0);
});

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test requirements after the endpoint contract regressions. */
