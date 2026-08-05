import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  awaitOneNotification,
  firstTextPart,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
  type ConnectedAgent,
} from "../helpers.js";

import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";

const EXTRA_EVENT_SETTLE_MS = 250;

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

/**
 * Fork a "drop the first frame, then collect any extras" collector.
 * @param receiver Value supplied to the operation.
 * @returns The fork extra collector result.
 */
function forkExtraCollector(receiver: ConnectedAgent) {
  return receiver.client
    .subscribe(messageReceivedNotificationDefinition)
    .pipe(
      Stream.drop(1),
      Stream.interruptAfter(Duration.millis(EXTRA_EVENT_SETTLE_MS)),
      Stream.runCollect,
      Effect.fork,
    );
}

interface DmConversation {
  readonly conversationId: ConversationId;
  readonly receiverIdx: number;
}

function setupDmConversations(
  sender: ConnectedAgent,
  receivers: readonly ConnectedAgent[],
): Effect.Effect<readonly DmConversation[], unknown> {
  return Effect.forEach(
    receivers,
    (receiver, i) =>
      Effect.map(
        sender.client.sendRpc(agentConversationCreate, {
          participants: [receiver.agentId],
        }),
        (result) => ({
          conversationId: result.conversation.id,
          receiverIdx: i,
        }),
      ),
    { concurrency: 1 },
  );
}

function sendToAll(
  sender: ConnectedAgent,
  conversations: readonly DmConversation[],
) {
  return Effect.all(
    conversations.map((conv, i) =>
      sender.client.sendRpc(messagesSend, {
        conversationId: conv.conversationId,
        parts: [{ type: "text", text: `Hello receiver-${i + 1}` }],
      }),
    ),
    { concurrency: conversations.length },
  );
}

it("multiple DMs receive messages simultaneously without cross-talk", () =>
  Effect.gen(function* () {
    const { agents } = yield* setupAgentGroup(5);
    const sender =
      /* Safe because the test fixture establishes this asserted shape. */ agents[0]!;
    const receivers = agents.slice(1);

    const conversations = yield* setupDmConversations(sender, receivers);

    const extraCollectors = yield* Effect.all(
      receivers.map((receiver) => forkExtraCollector(receiver)),
      { concurrency: receivers.length },
    );
    const eventFibers = yield* Effect.all(
      receivers.map((receiver) =>
        Effect.fork(
          awaitOneNotification(
            receiver.client,
            messageReceivedNotificationDefinition,
          ),
        ),
      ),
      { concurrency: receivers.length },
    );

    yield* sendToAll(sender, conversations);

    const events = yield* Effect.all(
      eventFibers.map((fiber) => Fiber.join(fiber)),
      { concurrency: receivers.length },
    );

    for (let i = 0; i < events.length; i++) {
      const message =
        /* Safe because the test fixture establishes this asserted shape. */ events[
          i
        ]!.params.message;

      expect(message.conversationId).toBe(
        /* Safe because the test fixture establishes this asserted shape. */ conversations[
          i
        ]!.conversationId,
      );
      expect(firstTextPart(message.parts)).toBe(`Hello receiver-${i + 1}`);
    }

    // No extra events: settle-window collector forked before sends;
    // expected first frame dropped via `Stream.drop(1)`.
    for (const collector of extraCollectors) {
      const extra = Chunk.toReadonlyArray(yield* Fiber.join(collector));
      expect(extra).toHaveLength(0);
    }
  }));
