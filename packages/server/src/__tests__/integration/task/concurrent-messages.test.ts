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
  DEFAULT_APP_ID,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskRequest,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol";

let _baseUrl: string;
let _wsUrl: string;
const EXTRA_EVENT_SETTLE_MS = 250;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      _baseUrl = server.baseUrl;
      _wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

/**
 * Fork a "drop the first frame, then collect any extras" collector
 * (#645): the legacy `drainNotifications` historical queue is gone,
 * so the no-extra-event assertion must subscribe BEFORE the
 * triggering send.
 */
function forkExtraCollector(receiver: ConnectedAgent) {
  return receiver.client
    .subscribe(MessageReceivedNotificationDefinition)
    .pipe(
      Stream.drop(1),
      Stream.interruptAfter(Duration.millis(EXTRA_EVENT_SETTLE_MS)),
      Stream.runCollect,
      Effect.fork,
    );
}

interface DmConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly receiverIdx: number;
}

function setupDmConversations(
  sender: ConnectedAgent,
  receivers: ReadonlyArray<ConnectedAgent>,
): Effect.Effect<ReadonlyArray<DmConversation>, unknown> {
  return Effect.forEach(
    receivers,
    (receiver, i) =>
      Effect.map(
        sender.client.sendRpc(TaskRequest, {
          appId: DEFAULT_APP_ID,
          invitedAgentIds: [receiver.agentId],
          initialConversation: {
            participants: [receiver.agentId],
          },
        }),
        (result) => ({
          taskId: result.task.id,
          conversationId: result.conversation!.id,
          receiverIdx: i,
        }),
      ),
    { concurrency: 1 },
  );
}

function sendToAll(
  sender: ConnectedAgent,
  conversations: ReadonlyArray<DmConversation>,
) {
  return Effect.all(
    conversations.map((conv, i) =>
      sender.client.sendRpc(MessagesSend, {
        taskId: conv.taskId,
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
    const sender = agents[0]!;
    const receivers = agents.slice(1);

    const conversations = yield* setupDmConversations(sender, receivers);

    const extraCollectors = yield* Effect.all(
      receivers.map((receiver) => forkExtraCollector(receiver)),
      { concurrency: receivers.length },
    );

    yield* sendToAll(sender, conversations);

    const events = yield* Effect.all(
      receivers.map((r) =>
        awaitOneNotification(r.client, MessageReceivedNotificationDefinition),
      ),
      { concurrency: receivers.length },
    );

    for (let i = 0; i < events.length; i++) {
      const message = events[i]!.params.message;

      expect(message.conversationId).toBe(conversations[i]!.conversationId);
      expect(firstTextPart(message.parts)).toBe(`Hello receiver-${i + 1}`);
    }

    // No extra events: settle-window collector forked before sends;
    // expected first frame dropped via `Stream.drop(1)`.
    for (const collector of extraCollectors) {
      const extra = Chunk.toReadonlyArray(yield* Fiber.join(collector));
      expect(extra).toHaveLength(0);
    }
  }));
