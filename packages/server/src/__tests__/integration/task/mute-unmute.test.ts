import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
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

    // Bob sends a message — Eve should receive, Alice should NOT
    yield* bob.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: MUTED_MESSAGE_TEXT }],
    });
    yield* awaitOneNotification(
      eve.client,
      MessageReceivedNotificationDefinition,
    );

    // Wait for any stray events to arrive, then verify Alice got nothing
    yield* Effect.sleep(STRAY_EVENT_SETTLE_MS);
    const aliceDrained = yield* alice.client.drainNotifications;
    const aliceMutedEvents = aliceDrained.filter(
      (e) => e.definition === MessageReceivedNotificationDefinition,
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
