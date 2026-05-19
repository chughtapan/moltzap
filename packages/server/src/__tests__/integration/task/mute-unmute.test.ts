import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";

import {
  ConversationsMute,
  ConversationsUnmute,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

const STRAY_EVENT_SETTLE_MS = 500;
const MUTED_MESSAGE_TEXT = "Alice is muted";
const UNMUTED_MESSAGE_TEXT = "Alice is back";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("muted participant does not receive messages, unmuted participant does", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(3, {
      groupName: "Mute Test",
    });
    const [alice, bob, eve] = group.agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];
    const conversationId = group.conversationId!;

    // Alice mutes the conversation
    yield* alice.client.sendRpc(ConversationsMute, { conversationId });

    // Fork a collector on Alice's notification Stream BEFORE the muted
    // send so the settle-window assertion observes every frame that
    // would otherwise have been dropped (#645: drainNotifications is
    // deleted; the new Stream.async-backed subscription is "live" from
    // materialisation onwards). The collector runs for the settle
    // window and surfaces whatever arrived.
    const aliceCollector = yield* alice.client
      .subscribe(MessageReceivedNotificationDefinition)
      .pipe(
        Stream.interruptAfter(Duration.millis(STRAY_EVENT_SETTLE_MS)),
        Stream.runCollect,
        Effect.fork,
      );

    // Bob sends a message — Eve should receive, Alice should NOT
    yield* bob.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: MUTED_MESSAGE_TEXT }],
    });
    yield* awaitOneNotification(
      eve.client,
      MessageReceivedNotificationDefinition,
    );

    // Wait for the collector to finish (covers the stray-event settle
    // window) and assert nothing landed on Alice's stream.
    const aliceMutedEvents = Chunk.toReadonlyArray(
      yield* Fiber.join(aliceCollector),
    );
    expect(aliceMutedEvents).toHaveLength(0);

    // Alice unmutes
    yield* alice.client.sendRpc(ConversationsUnmute, {
      conversationId,
    });

    // Bob sends another message — Alice SHOULD receive it now
    yield* bob.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: UNMUTED_MESSAGE_TEXT }],
    });
    const aliceEvent = yield* awaitOneNotification(
      alice.client,
      MessageReceivedNotificationDefinition,
    );
    expect(
      (aliceEvent.params as { message: { parts: Array<{ text: string }> } })
        .message.parts[0]!.text,
    ).toBe(UNMUTED_MESSAGE_TEXT);
  }));
