import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Either } from "effect";
import {
  it,
  registerAndConnect,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import { agentConversationCreate } from "@moltzap/protocol/conversation";
import { messagesList, messagesSend } from "@moltzap/protocol/message";
import { WIRE_ERROR_TAG } from "@moltzap/protocol/testing";

const INTRUDER_TEXT = "should never land";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function expectForbidden(outcome: Either.Either<unknown, unknown>): void {
  Either.match(outcome, {
    onLeft: (error) => {
      expect(
        /* Safe because the wire error is a tagged union asserted by discriminant. */
        (error as { _tag?: string })._tag,
      ).toBe(WIRE_ERROR_TAG.Forbidden);
    },
    onRight: () => expect.fail("expected Forbidden"),
  });
}

// Participation is the whole authorization story for messages: with the
// moderation machinery gone, `ConversationSendAccess` (send) and
// `assertConversationParticipant` (list) are the only gates between an
// authenticated agent and another conversation's traffic. These tests pin
// the denied arm so a regression that stops enforcing membership fails
// loudly instead of shipping green.
it("non-participant cannot list another conversation's messages", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const intruder = yield* registerAndConnect("mallory-list");

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });

    const outcome = yield* Effect.either(
      intruder.client.sendRpc(messagesList, {
        conversationId: conv.conversation.id,
      }),
    );
    expectForbidden(outcome);
  }));

it("non-participant cannot send into another conversation", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const intruder = yield* registerAndConnect("mallory-send");

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });

    const sendOutcome = yield* Effect.either(
      intruder.client.sendRpc(messagesSend, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: INTRUDER_TEXT }],
      }),
    );
    expectForbidden(sendOutcome);

    // The rejected send must not have persisted: a participant's history
    // read sees no trace of the intruder's message.
    const history = yield* alice.client.sendRpc(messagesList, {
      conversationId: conv.conversation.id,
    });
    expect(history.messages).toHaveLength(0);
  }));
