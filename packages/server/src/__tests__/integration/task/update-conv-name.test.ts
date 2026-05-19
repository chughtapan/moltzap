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
  ConversationsList,
  ConversationsUpdate,
  ConversationUpdatedNotificationDefinition,
} from "@moltzap/protocol";

const OLD_CONVERSATION_NAME = "Old Name";
const NEW_CONVERSATION_NAME = "New Name";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("conversation rename broadcasts update event and persists", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(3, {
      groupName: OLD_CONVERSATION_NAME,
    });
    const [alice, bob, eve] = group.agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];
    const conversationId = group.conversationId!;

    // Set up event waiters on Bob and Eve BEFORE the update

    const updateResult = (yield* alice.client.sendRpc(ConversationsUpdate, {
      conversationId,
      name: NEW_CONVERSATION_NAME,
    })) as { conversation: { id: string; name: string } };

    expect(updateResult.conversation.name).toBe(NEW_CONVERSATION_NAME);

    const bobUpdated = yield* awaitOneNotification(
      bob.client,
      ConversationUpdatedNotificationDefinition,
    );
    const eveUpdated = yield* awaitOneNotification(
      eve.client,
      ConversationUpdatedNotificationDefinition,
    );

    expect(
      (bobUpdated.params as { conversation: { name: string } }).conversation
        .name,
    ).toBe(NEW_CONVERSATION_NAME);
    expect(
      (eveUpdated.params as { conversation: { name: string } }).conversation
        .name,
    ).toBe(NEW_CONVERSATION_NAME);

    // Verify persistence via conversations/list
    const listResult = (yield* alice.client.sendRpc(ConversationsList, {})) as {
      conversations: Array<{ id: string; name?: string }>;
    };
    const found = listResult.conversations.find((c) => c.id === conversationId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(NEW_CONVERSATION_NAME);
  }));
